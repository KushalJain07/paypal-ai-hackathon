alter table public.payments
  drop constraint payments_mandate_invoice_unique;

create unique index payments_mandate_invoice_active_unique
  on public.payments (mandate_id, invoice_id)
  where status <> 'rejected';

alter table public.decisions
  add column phase text not null default 'authorized'
  check (phase in ('preflight', 'authorized'));

alter table public.payments
  add column approval_url text;

create table public.payment_action_claims (
  payment_id uuid primary key references public.payments (id) on delete cascade,
  action text not null check (action in ('undo', 'release', 'refund')),
  claimed_at timestamptz not null
);
alter table public.payment_action_claims enable row level security;

create or replace function public.reserve_payment(
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
  if v_mandate.expires_at <= p_created_at then
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
       and status <> 'rejected'
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
    id, mandate_id, invoice_id, amount, currency, payee_email, status,
    created_at, updated_at
  )
  values (
    p_id, p_mandate_id, p_invoice_id, p_amount, p_currency, p_payee_email,
    'requested', p_created_at, p_created_at
  )
  returning * into v_payment;

  insert into public.events (
    payment_id, type, from_status, to_status, detail, created_at
  )
  values (
    v_payment.id, 'payment_requested', null, 'requested',
    jsonb_build_object('invoice_id', p_invoice_id, 'amount', p_amount),
    p_created_at
  );
  return next v_payment;
end;
$$;

create function public.create_rejected_payment(
  p_id uuid,
  p_mandate_id uuid,
  p_invoice_id text,
  p_amount bigint,
  p_currency text,
  p_payee_email text,
  p_created_at timestamptz,
  p_reason text,
  p_decision jsonb
)
returns setof public.payments
language plpgsql
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
begin
  insert into public.payments (
    id, mandate_id, invoice_id, amount, currency, payee_email, status,
    failure_reason, created_at, updated_at
  )
  values (
    p_id, p_mandate_id, p_invoice_id, p_amount, p_currency, p_payee_email,
    'rejected', p_reason, p_created_at, p_created_at
  )
  returning * into v_payment;

  insert into public.events (
    payment_id, type, from_status, to_status, detail, created_at
  )
  values (
    v_payment.id, 'payment_rejected', null, 'rejected',
    jsonb_build_object(
      'failed_rules',
      (select coalesce(string_agg(item->>'rule', ','), '')
         from jsonb_array_elements(p_decision->'results') as result(item)
        where not coalesce((item->>'passed')::boolean, false)
      ),
      'reason', p_reason,
      'phase', p_decision->>'phase'
    ),
    p_created_at
  );
  insert into public.decisions (
    payment_id, phase, rule, passed, expected, actual, created_at
  )
  select
    v_payment.id,
    p_decision->>'phase',
    item->>'rule',
    (item->>'passed')::boolean,
    item->'expected',
    item->'actual',
    p_created_at
  from jsonb_array_elements(p_decision->'results') as result(item);
  return next v_payment;
end;
$$;

create function public.update_mandate(p_mandate jsonb)
returns setof public.mandates
language plpgsql
set search_path = ''
as $$
declare
  v_current public.mandates%rowtype;
  v_updated public.mandates%rowtype;
begin
  if jsonb_typeof(p_mandate) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'INVALID_RECORD';
  end if;
  select * into v_current
    from public.mandates
   where id = (p_mandate->>'id')::uuid
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MANDATE_NOT_FOUND';
  end if;
  v_updated := jsonb_populate_record(v_current, p_mandate);
  update public.mandates
     set version = v_updated.version,
         payee_email = v_updated.payee_email,
         per_payment_cap = v_updated.per_payment_cap,
         total_cap = v_updated.total_cap,
         spent_total = v_current.spent_total,
         reserved_total = v_current.reserved_total,
         currency = v_updated.currency,
         purpose = v_updated.purpose,
         expires_at = v_updated.expires_at,
         undo_window_seconds = v_updated.undo_window_seconds,
         status = v_updated.status,
         signature = v_updated.signature,
         hash = v_updated.hash
   where id = v_current.id
   returning * into v_updated;
  return next v_updated;
end;
$$;

create function public.attach_paypal_order(
  p_payment_id uuid,
  p_order_id text,
  p_approval_url text,
  p_at timestamptz
)
returns setof public.payments
language plpgsql
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
begin
  select * into v_payment from public.payments
   where id = p_payment_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_NOT_FOUND';
  end if;
  if v_payment.status <> 'requested' or v_payment.paypal_order_id is not null then
    raise exception using errcode = 'P0001', message = 'PAYMENT_STATUS_CONFLICT';
  end if;

  update public.payments
     set paypal_order_id = p_order_id,
         approval_url = p_approval_url,
         updated_at = p_at
   where id = p_payment_id
   returning * into v_payment;
  insert into public.events (
    payment_id, type, from_status, to_status, detail, created_at
  )
  values (
    p_payment_id, 'paypal_order_created', 'requested', 'requested',
    jsonb_build_object('paypal_order_id', p_order_id), p_at
  );
  return next v_payment;
end;
$$;

create function public.claim_payment_action(
  p_payment_id uuid,
  p_expected_status text,
  p_action text,
  p_at timestamptz,
  p_due_at timestamptz default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_claimed uuid;
begin
  select * into v_payment from public.payments
   where id = p_payment_id for update;
  if not found or v_payment.status <> p_expected_status then
    return false;
  end if;
  if p_action not in ('undo', 'release', 'refund') then
    raise exception using errcode = 'P0001', message = 'INVALID_ACTION';
  end if;
  if p_action in ('undo', 'release') and v_payment.status <> 'held' then
    return false;
  end if;
  if p_action = 'refund' and v_payment.status <> 'captured' then
    return false;
  end if;
  if p_action = 'release' and (
    p_due_at is null or v_payment.release_at is null or v_payment.release_at > p_due_at
  ) then
    return false;
  end if;

  insert into public.payment_action_claims (payment_id, action, claimed_at)
  values (p_payment_id, p_action, p_at)
  on conflict (payment_id) do update
    set action = excluded.action,
        claimed_at = excluded.claimed_at
    where public.payment_action_claims.claimed_at <= p_at - interval '2 minutes'
  returning payment_id into v_claimed;
  return v_claimed is not null;
end;
$$;

create function public.clear_payment_action_claim(
  p_payment_id uuid,
  p_action text
)
returns void
language sql
set search_path = ''
as $$
  delete from public.payment_action_claims
   where payment_id = p_payment_id and action = p_action;
$$;

create function public.transition_payment(
  p_payment_id uuid,
  p_expected_status text,
  p_next_status text,
  p_at timestamptz,
  p_budget_effect text,
  p_event_type text,
  p_detail jsonb,
  p_paypal_order_id text default null,
  p_authorization_id text default null,
  p_capture_id text default null,
  p_release_at timestamptz default null,
  p_failure_reason text default null,
  p_claim_action text default null
)
returns setof public.payments
language plpgsql
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_mandate public.mandates%rowtype;
  v_reserved_delta bigint := 0;
  v_spent_delta bigint := 0;
  v_allowed boolean := false;
begin
  select * into v_payment from public.payments
   where id = p_payment_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_NOT_FOUND';
  end if;
  if v_payment.status <> p_expected_status then
    raise exception using errcode = 'P0001', message = 'PAYMENT_STATUS_CONFLICT';
  end if;

  v_allowed :=
    (p_expected_status = 'requested' and p_next_status in ('authorized', 'failed'))
    or (p_expected_status = 'authorized' and p_next_status in ('held', 'rejected', 'failed'))
    or (p_expected_status = 'held' and p_next_status in ('captured', 'voided', 'failed'))
    or (p_expected_status = 'captured' and p_next_status = 'refunded');
  if not v_allowed then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
  end if;

  select * into v_mandate from public.mandates
   where id = v_payment.mandate_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MANDATE_NOT_FOUND';
  end if;
  case p_budget_effect
    when 'release_reserved' then v_reserved_delta := -v_payment.amount;
    when 'reserved_to_spent' then
      v_reserved_delta := -v_payment.amount;
      v_spent_delta := v_payment.amount;
    when 'restore_spent' then v_spent_delta := -v_payment.amount;
    when 'none' then null;
    else raise exception using errcode = 'P0001', message = 'INVALID_BUDGET_EFFECT';
  end case;

  if p_budget_effect in ('release_reserved', 'reserved_to_spent')
    and v_mandate.reserved_total < v_payment.amount then
    raise exception using errcode = 'P0001', message = 'BUDGET_INVARIANT_FAILED';
  end if;
  if p_budget_effect = 'restore_spent'
    and v_mandate.spent_total < v_payment.amount then
    raise exception using errcode = 'P0001', message = 'BUDGET_INVARIANT_FAILED';
  end if;
  if p_budget_effect = 'reserved_to_spent'
    and v_mandate.spent_total > v_mandate.total_cap - v_payment.amount then
    raise exception using errcode = 'P0001', message = 'BUDGET_INVARIANT_FAILED';
  end if;

  update public.mandates
     set reserved_total = reserved_total + v_reserved_delta,
         spent_total = spent_total + v_spent_delta
   where id = v_mandate.id;
  update public.payments
     set status = p_next_status,
         paypal_order_id = coalesce(p_paypal_order_id, paypal_order_id),
         authorization_id = coalesce(p_authorization_id, authorization_id),
         capture_id = coalesce(p_capture_id, capture_id),
         release_at = p_release_at,
         failure_reason = p_failure_reason,
         updated_at = p_at
   where id = p_payment_id
   returning * into v_payment;
  insert into public.events (
    payment_id, type, from_status, to_status, detail, created_at
  )
  values (
    p_payment_id, p_event_type, p_expected_status, p_next_status,
    coalesce(p_detail, '{}'::jsonb), p_at
  );
  if p_claim_action is not null then
    if not exists (
      select 1
        from public.payment_action_claims
        where payment_id = p_payment_id
          and action = p_claim_action
    ) then
      raise exception using errcode = 'P0001', message = 'ACTION_ALREADY_CLAIMED';
    end if;
    delete from public.payment_action_claims
     where payment_id = p_payment_id and action = p_claim_action;
  end if;
  return next v_payment;
end;
$$;

grant select, insert, update, delete on public.payment_action_claims to service_role;
revoke all on function public.reserve_payment(
  uuid, uuid, text, bigint, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.create_rejected_payment(
  uuid, uuid, text, bigint, text, text, timestamptz, text, jsonb
) from public, anon, authenticated;
revoke all on function public.update_mandate(jsonb)
  from public, anon, authenticated;
revoke all on function public.attach_paypal_order(uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.claim_payment_action(
  uuid, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.clear_payment_action_claim(uuid, text)
  from public, anon, authenticated;
revoke all on function public.transition_payment(
  uuid, text, text, timestamptz, text, text, jsonb, text, text, text,
  timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.create_rejected_payment(
  uuid, uuid, text, bigint, text, text, timestamptz, text, jsonb
) to service_role;
grant execute on function public.update_mandate(jsonb) to service_role;
grant execute on function public.attach_paypal_order(uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.claim_payment_action(
  uuid, text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.clear_payment_action_claim(uuid, text)
  to service_role;
grant execute on function public.transition_payment(
  uuid, text, text, timestamptz, text, text, jsonb, text, text, text,
  timestamptz, text, text
) to service_role;
grant execute on function public.reserve_payment(
  uuid, uuid, text, bigint, text, text, timestamptz
) to service_role;
