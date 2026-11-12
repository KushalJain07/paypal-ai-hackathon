create function public.smoke_test_reservation()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mandate_id uuid := pg_catalog.gen_random_uuid();
  v_payment_id uuid := pg_catalog.gen_random_uuid();
  v_payment public.payments%rowtype;
  v_duplicate_rejected boolean := false;
  v_over_budget_rejected boolean := false;
  v_result jsonb;
  v_now timestamptz := pg_catalog.now();
begin
  begin
    insert into public.mandates (
      id,
      version,
      payee_email,
      per_payment_cap,
      total_cap,
      currency,
      purpose,
      expires_at,
      undo_window_seconds,
      status,
      signature,
      hash,
      created_at
    )
    values (
      v_mandate_id,
      1,
      'rewind-smoke@example.com',
      10000,
      10000,
      'USD',
      'Transactional persistence smoke test',
      v_now + interval '1 hour',
      60,
      'active',
      'smoke-test-signature',
      'smoke-test-hash',
      v_now
    );

    select *
      into v_payment
      from public.reserve_payment(
        v_payment_id,
        v_mandate_id,
        'smoke-invoice-' || v_payment_id::text,
        7000,
        'USD',
        'rewind-smoke@example.com',
        v_now
      );

    if v_payment.id <> v_payment_id
      or v_payment.status <> 'requested'
      or v_payment.amount <> 7000
    then
      raise exception using
        errcode = 'P0001',
        message = 'SMOKE_PAYMENT_READBACK_MISMATCH';
    end if;

    begin
      perform *
        from public.reserve_payment(
          pg_catalog.gen_random_uuid(),
          v_mandate_id,
          v_payment.invoice_id,
          1000,
          'USD',
          'rewind-smoke@example.com',
          v_now
        );
    exception
      when sqlstate 'P0001' then
        if sqlerrm = 'DUPLICATE_INVOICE' then
          v_duplicate_rejected := true;
        else
          raise;
        end if;
    end;

    begin
      perform *
        from public.reserve_payment(
          pg_catalog.gen_random_uuid(),
          v_mandate_id,
          'smoke-over-budget-' || v_payment_id::text,
          4000,
          'USD',
          'rewind-smoke@example.com',
          v_now
        );
    exception
      when sqlstate 'P0001' then
        if sqlerrm = 'BUDGET_EXCEEDED' then
          v_over_budget_rejected := true;
        else
          raise;
        end if;
    end;

    if not v_duplicate_rejected then
      raise exception using errcode = 'P0001', message = 'SMOKE_DUPLICATE_INVOICE_NOT_REJECTED';
    end if;
    if not v_over_budget_rejected then
      raise exception using errcode = 'P0001', message = 'SMOKE_OVER_BUDGET_NOT_REJECTED';
    end if;

    v_result := pg_catalog.jsonb_build_object(
      'payment_readback',
      true,
      'duplicate_invoice_rejected',
      v_duplicate_rejected,
      'over_budget_rejected',
      v_over_budget_rejected,
      'cleanup',
      'transaction_rolled_back'
    );

    raise exception using
      errcode = 'P0002',
      message = 'ROLLBACK_SMOKE_TEST';
  exception
    when sqlstate 'P0002' then
      null;
  end;

  return v_result;
end;
$$;

revoke all on function public.smoke_test_reservation() from public, anon, authenticated;
grant execute on function public.smoke_test_reservation() to service_role;
grant select, insert, update, delete
  on public.mandates, public.payments
  to service_role;
grant select, insert
  on public.decisions, public.events
  to service_role;
grant usage, select
  on all sequences in schema public
  to service_role;
