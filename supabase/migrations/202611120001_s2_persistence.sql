create table public.mandates (
  id uuid primary key,
  version integer not null check (version > 0),
  payee_email text not null check (payee_email = btrim(payee_email)),
  per_payment_cap bigint not null check (
    per_payment_cap > 0 and per_payment_cap <= 9007199254740991
  ),
  total_cap bigint not null check (
    total_cap > 0 and total_cap <= 9007199254740991
  ),
  spent_total bigint not null default 0 check (spent_total >= 0),
  reserved_total bigint not null default 0 check (reserved_total >= 0),
  currency text not null check (currency = 'USD'),
  purpose text not null check (char_length(purpose) <= 200),
  expires_at timestamptz not null,
  undo_window_seconds integer not null check (
    undo_window_seconds between 10 and 3600
  ),
  status text not null check (status in ('active', 'expired', 'revoked')),
  signature text not null check (length(signature) > 0),
  hash text not null check (length(hash) > 0),
  created_at timestamptz not null,
  constraint mandates_per_payment_cap_lte_total_cap
    check (per_payment_cap <= total_cap),
  constraint mandates_budget_within_cap
    check (spent_total <= total_cap and reserved_total <= total_cap - spent_total)
);

create table public.payments (
  id uuid primary key,
  mandate_id uuid not null references public.mandates (id),
  invoice_id text not null check (length(btrim(invoice_id)) > 0),
  amount bigint not null check (amount > 0 and amount <= 9007199254740991),
  currency text not null check (currency = 'USD'),
  payee_email text not null,
  paypal_order_id text unique,
  authorization_id text unique,
  capture_id text unique,
  status text not null check (
    status in (
      'requested',
      'authorized',
      'rejected',
      'held',
      'captured',
      'voided',
      'refunded',
      'failed'
    )
  ),
  release_at timestamptz,
  failure_reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint payments_mandate_invoice_unique unique (mandate_id, invoice_id)
);

create table public.decisions (
  id bigint generated always as identity primary key,
  payment_id uuid not null references public.payments (id),
  rule text not null check (rule in ('R1', 'R2', 'R3', 'R4', 'R5')),
  passed boolean not null,
  expected jsonb not null,
  actual jsonb not null,
  created_at timestamptz not null
);

create table public.events (
  id bigint generated always as identity primary key,
  payment_id uuid not null references public.payments (id),
  type text not null check (length(type) > 0),
  from_status text check (
    from_status is null or from_status in (
      'requested',
      'authorized',
      'rejected',
      'held',
      'captured',
      'voided',
      'refunded',
      'failed'
    )
  ),
  to_status text check (
    to_status is null or to_status in (
      'requested',
      'authorized',
      'rejected',
      'held',
      'captured',
      'voided',
      'refunded',
      'failed'
    )
  ),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create index payments_mandate_created_at_idx
  on public.payments (mandate_id, created_at desc);
create index payments_release_at_idx
  on public.payments (release_at)
  where status = 'held';
create index decisions_payment_created_at_idx
  on public.decisions (payment_id, created_at);
create index events_payment_created_at_idx
  on public.events (payment_id, created_at, id);

create function public.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'APPEND_ONLY_RECORD';
end;
$$;

create trigger decisions_append_only
before update or delete on public.decisions
for each row execute function public.reject_append_only_mutation();

create trigger decisions_no_truncate
before truncate on public.decisions
for each statement execute function public.reject_append_only_mutation();

create trigger events_append_only
before update or delete on public.events
for each row execute function public.reject_append_only_mutation();

create trigger events_no_truncate
before truncate on public.events
for each statement execute function public.reject_append_only_mutation();

alter table public.mandates enable row level security;
alter table public.payments enable row level security;
alter table public.decisions enable row level security;
alter table public.events enable row level security;

grant select, insert, update, delete
  on public.mandates, public.payments
  to service_role;
grant select, insert
  on public.decisions, public.events
  to service_role;
grant usage, select
  on all sequences in schema public
  to service_role;

create function public.reserve_payment(
  p_id uuid,
  p_mandate_id uuid,
  p_invoice_id text,
  p_amount bigint,
  p_currency text,
  p_payee_email text,
  p_created_at timestamptz
)
returns setof public.payments
language plpgsql
set search_path = ''
as $$
declare
  v_mandate public.mandates%rowtype;
  v_payment public.payments%rowtype;
begin
  select *
    into v_mandate
    from public.mandates
   where id = p_mandate_id
   for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'MANDATE_NOT_FOUND';
  end if;

  if v_mandate.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'MANDATE_INACTIVE';
  end if;

  if v_mandate.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'MANDATE_EXPIRED';
  end if;

  if p_currency is distinct from v_mandate.currency then
    raise exception using errcode = 'P0001', message = 'CURRENCY_MISMATCH';
  end if;

  if p_amount is null or p_amount <= 0 or p_amount > v_mandate.per_payment_cap then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_INVALID';
  end if;

  if p_invoice_id is null or length(btrim(p_invoice_id)) = 0 then
    raise exception using errcode = 'P0001', message = 'INVOICE_ID_REQUIRED';
  end if;

  if p_payee_email is null
    or p_payee_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
  then
    raise exception using errcode = 'P0001', message = 'INVALID_PAYEE_EMAIL';
  end if;

  if exists (
    select 1
      from public.payments
     where mandate_id = p_mandate_id
       and invoice_id = p_invoice_id
  ) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_INVOICE';
  end if;

  if p_amount > v_mandate.total_cap - v_mandate.spent_total - v_mandate.reserved_total then
    raise exception using errcode = 'P0001', message = 'BUDGET_EXCEEDED';
  end if;

  update public.mandates
     set reserved_total = reserved_total + p_amount
   where id = p_mandate_id;

  insert into public.payments (
    id,
    mandate_id,
    invoice_id,
    amount,
    currency,
    payee_email,
    status,
    created_at,
    updated_at
  )
  values (
    p_id,
    p_mandate_id,
    p_invoice_id,
    p_amount,
    p_currency,
    p_payee_email,
    'requested',
    p_created_at,
    p_created_at
  )
  returning * into v_payment;

  insert into public.events (
    payment_id,
    type,
    from_status,
    to_status,
    detail,
    created_at
  )
  values (
    v_payment.id,
    'payment_requested',
    null,
    'requested',
    jsonb_build_object('invoice_id', p_invoice_id, 'amount', p_amount),
    p_created_at
  );

  return next v_payment;
end;
$$;

grant execute on function public.reserve_payment(
  uuid,
  uuid,
  text,
  bigint,
  text,
  text,
  timestamptz
) to service_role;
