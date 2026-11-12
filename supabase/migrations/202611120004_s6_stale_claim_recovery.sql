create function public.claim_payment_action_v2(
  p_payment_id uuid,
  p_expected_status text,
  p_action text,
  p_at timestamptz,
  p_due_at timestamptz default null,
  p_stale_after_seconds integer default 120
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_claimed uuid;
begin
  if p_stale_after_seconds < 1 or p_stale_after_seconds > 86400 then
    raise exception using errcode = 'P0001', message = 'INVALID_STALE_CLAIM_AGE';
  end if;
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
    where public.payment_action_claims.claimed_at
      <= p_at - make_interval(secs => p_stale_after_seconds)
  returning payment_id into v_claimed;
  return v_claimed is not null;
end;
$$;

create function public.list_stale_release_claims(p_before timestamptz)
returns table (payment_id uuid, claimed_at timestamptz)
language sql
set search_path = ''
as $$
  select claims.payment_id, claims.claimed_at
    from public.payment_action_claims as claims
    join public.payments as payments on payments.id = claims.payment_id
   where claims.action = 'release'
     and claims.claimed_at < p_before
     and payments.status = 'held'
   order by claims.claimed_at
   limit 500;
$$;

revoke all on function public.claim_payment_action_v2(
  uuid, text, text, timestamptz, timestamptz, integer
) from public, anon, authenticated;
revoke all on function public.list_stale_release_claims(timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_payment_action_v2(
  uuid, text, text, timestamptz, timestamptz, integer
) to service_role;
grant execute on function public.list_stale_release_claims(timestamptz)
  to service_role;
