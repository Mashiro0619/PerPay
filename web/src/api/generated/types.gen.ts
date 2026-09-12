
export type ClientOptions = {
    baseUrl: `${string}://${string}` | (string & {});
};
export type Webhooks = ReceivePaymentOrderWebhookWebhookRequest;
export type Health = {
    status: 'healthy' | 'unhealthy';
    version: string;
    uptime_seconds: number;
    database: DatabaseHealth;
};
export type Readiness = {
    status: 'ready' | 'degraded' | 'not_ready';
    code: 'system_not_ready' | 'system_not_configured' | 'reconciliation_not_ready' | null;
};
export type DatabaseHealth = {
    ok: boolean;
    result: string;
};
export type SystemStatusEnvelope = {
    data: SystemStatus;
};
export type SystemStatus = {
    status: 'ready' | 'degraded' | 'not_ready';
    version: string;
    instance_id: string;
    initialized: boolean;
    configured: boolean;
    settings_revision: number | null;
    payment_revision: number;
    provider_account_key: string | null;
    database: DatabaseHealth;
    ledger: LedgerHealth;
    reconciliation: ReconciliationHealth;
    webhook: WebhookHealth;
    backup: BackupHealth;
};
export type SystemAnalyticsEnvelope = {
    data: SystemAnalytics;
};
export type SystemAnalytics = {
    range_days: 7 | 30 | 90;
    from: string;
    to: string;
    orders: {
        created: number;
        unpaid: number;
        confirmed: number;
        disputed: number;
        closed: number;
        expired: number;
    };
    confirmations: {
        count: number;
        amount_cents: number;
    };
    notifications: {
        acknowledged: number;
        failed: number;
        pending: number;
    };
    pending: {
        orders: number;
        exceptions: number;
        conflicts: number;
        notifications: number;
    };
    daily: Array<{
        date: string;
        orders_created: number;
        confirmations: number;
        confirmed_amount_cents: number;
        notifications_acknowledged: number;
        notifications_failed: number;
    }>;
};
export type AdminWorkItemTypeFilter = 'ALL' | 'FINANCIAL_EXCEPTION' | 'LEDGER_CONFLICT' | 'NOTIFICATION_FAILURE';
export type AdminWorkItemPageEnvelope = {
    data: Array<AdminWorkItem>;
    page: {
        next_cursor: string | null;
    };
};
export type AdminWorkItem = ({
    type: 'FINANCIAL_EXCEPTION';
} & AdminFinancialExceptionWorkItem) | ({
    type: 'LEDGER_CONFLICT';
} & AdminLedgerConflictWorkItem) | ({
    type: 'NOTIFICATION_FAILURE';
} & AdminNotificationFailureWorkItem);
export type AdminWorkItemBase = {
    type: 'FINANCIAL_EXCEPTION' | 'LEDGER_CONFLICT' | 'NOTIFICATION_FAILURE';
    resource_id: ResourceId;
    provider_account_key: string;
    order_id: ResourceId | null;
    ledger_entry_id: ResourceId | null;
    created_at: string;
    actionable_at: string;
    detail_url: string;
};
export type AdminFinancialExceptionWorkItem = AdminWorkItemBase & {
    type?: 'FINANCIAL_EXCEPTION';
    status: 'OPEN';
    exception_type: 'UNMATCHED_CREDIT' | 'UNMATCHED_DEBIT' | 'AMBIGUOUS_MATCH' | 'CHECKOUT_ENDED_PAYMENT' | 'DUPLICATE_PAYMENT' | 'AMOUNT_MISMATCH' | 'UNLINKED_REFUND' | 'RECONCILIATION_CONFLICT';
    candidate_id: ResourceId | null;
};
export type AdminLedgerConflictWorkItem = AdminWorkItemBase & {
    type?: 'LEDGER_CONFLICT';
    status: 'OPEN';
    conflict_type: LedgerConflictType;
    external_event_id: string | null;
};
export type AdminNotificationFailureWorkItem = AdminWorkItemBase & {
    type?: 'NOTIFICATION_FAILURE';
    status: 'RETRY_WAIT' | 'DEAD_LETTER';
    event_type: string;
    attempt_count: number;
    next_attempt_at: string | null;
    last_error_code: string | null;
    dead_lettered_at: string | null;
    updated_at: string;
};
export type LedgerConflictSummary = {
    provider_account_key: string;
    open: number;
    resolved: number;
    ignored: number;
    total: number;
    by_type: Array<LedgerConflictTypeSummary>;
} | null;
export type LedgerConflictTypeSummary = {
    conflict_type: LedgerConflictType;
    open: number;
    resolved: number;
    ignored: number;
    total: number;
};
export type FinancialExceptionSummary = {
    provider_account_key: string;
    open: number;
    resolved: number;
    total: number;
} | null;
export type LedgerHealth = {
    enabled: boolean;
    state: 'idle' | 'running' | 'healthy' | 'catching_up' | 'degraded' | 'stopped';
    in_flight: boolean;
    last_attempt_at: number | null;
    last_success_at: number | null;
    last_error_code: string | null;
    consecutive_failures: number;
    collection_ready: boolean;
    last_success_age_milliseconds: number | null;
    maximum_success_age_milliseconds: number | null;
    conflicts: LedgerConflictSummary;
};
export type ReconciliationHealth = {
    enabled: boolean;
    state: 'idle' | 'running' | 'healthy' | 'degraded' | 'stopped';
    in_flight: boolean;
    last_attempt_at: number | null;
    last_success_at: number | null;
    last_error_code: string | null;
    consecutive_failures: number;
    pending_orders: number;
    continuation_pending: boolean;
    confirmation_ready: boolean;
    last_success_age_milliseconds: number | null;
    maximum_success_age_milliseconds: number | null;
    exceptions: FinancialExceptionSummary;
};
export type WebhookHealth = {
    enabled: boolean;
    state: 'idle' | 'running' | 'healthy' | 'degraded' | 'stopped';
    in_flight: boolean;
    last_attempt_at: number | null;
    last_success_at: number | null;
    last_error_code: string | null;
    consecutive_failures: number;
    pending_deliveries: number;
    dead_letters: number;
};
export type BackupHealth = {
    enabled: boolean;
    ok: boolean;
    status: 'disabled' | 'healthy' | 'unhealthy' | 'unavailable';
    last_attempt_at: number | null;
    last_success_at: number | null;
    last_error_at: number | null;
    last_error_stage: 'state' | 'database_backup' | 'verification' | 'retention' | 'restore' | 'unknown' | null;
    backup_name: string | null;
    backup_sha256: string | null;
    backup_size_bytes: number | null;
    instance_id: string | null;
    schema_version: number | null;
    interval_milliseconds: number | null;
    keep_count: number | null;
    retained_count: number | null;
    maximum_age_milliseconds: number | null;
    backup_required: boolean;
    backup_in_progress: boolean;
    backup_available: boolean;
    recovery_required: boolean;
    clock_moved_backwards: boolean;
    configuration_mismatch: boolean;
    instance_matches: boolean | null;
};
export type ResourceId = string;
export type AdminLoginRequest = {
    password: string;
    remember_me?: boolean;
};
export type AdminSetupRequest = {
    password: string;
};
export type AdminLoginEnvelope = {
    data: {
        username: string;
        csrf_token: string;
        idle_expires_at: string;
        absolute_expires_at: string;
    };
};
export type OfficialUpdateEnvelope = {
    data: OfficialUpdate;
};
export type OfficialUpdate = {
    status: 'update_available' | 'up_to_date' | 'ahead';
    current_version: string;
    latest_version: string;
    release_url: string;
    published_at: string;
    checked_at: string;
};
export type AdminSessionEnvelope = {
    data: {
        username: string;
        csrf_token_required: true;
        idle_expires_at: string;
        absolute_expires_at: string;
    };
};
export type AdminPasswordChangeRequest = {
    new_password: string;
};
export type AdminEmptyRequest = {
    [key: string]: never;
};
export type AdminRevokeAllEnvelope = {
    data: {
        revoked_sessions: number;
    };
};
export type RuntimeSettingsEnvelope = {
    data: RuntimeSettings;
};
export type RuntimeSettings = {
    revision: number;
    payment_revision: number;
    updated_at: string;
    completion: SettingsCompletion;
    collection: CollectionSettings | null;
    provider: ProviderSettings | null;
    application_public_key: string | null;
    application_key_fingerprint: Sha256Fingerprint | null;
    provider_generations: Array<ProviderGeneration>;
    notifications: NotificationSettings;
    advanced: AdvancedSettings;
    backup: BackupSettings;
    secrets: RuntimeSecretMetadataMap;
};
export type SettingsCompletion = {
    complete: boolean;
    application_key: boolean;
    collection: boolean;
    provider: boolean;
    api: boolean;
    notifications: boolean;
    next_step: 'GENERATE_APPLICATION_KEY' | 'CONFIGURE_PROVIDER' | 'CONFIGURE_COLLECTION' | 'GENERATE_API_KEY' | null;
};
export type CollectionSettings = {
    code_payload: string;
    order_ttl_seconds: number;
    amount_offset_maximum_cents: number;
};
export type ProviderSettings = {
    environment: 'PRODUCTION' | 'SANDBOX';
    app_id: string;
    provider_account_key: string;
    timeout_milliseconds: number;
    scan_interval_seconds: number;
    safety_lag_seconds: number;
    maximum_success_age_seconds: number;
};
export type ProviderGeneration = {
    provider_account_key: string;
    app_id: string;
    environment: 'PRODUCTION' | 'SANDBOX';
    activated_at: string;
    active: boolean;
};
export type NotificationSettings = {
    enabled: boolean;
    allowed_origin: string | null;
    timeout_milliseconds: number;
    maximum_attempts: number;
    retry_base_seconds: number;
    retry_maximum_seconds: number;
};
export type AdvancedSettings = {
    checkout_key_rotation_days: number;
    checkout_terminal_observation_seconds: number;
};
export type BackupSettings = {
    interval_seconds: number;
    keep_count: number;
};
export type RuntimeSecretName = 'api_secret' | 'provider_private_key' | 'provider_public_key' | 'webhook_secret';
export type RuntimeSecretMetadataMap = {
    api_secret: RuntimeSecretMetadata;
    provider_private_key: RuntimeSecretMetadata;
    provider_public_key: RuntimeSecretMetadata;
    webhook_secret: RuntimeSecretMetadata;
};
export type RuntimeSecretMetadata = {
    configured: boolean;
    version: number | null;
    fingerprint: Sha256Fingerprint | null;
    masked: string | null;
    updatedAt: number | null;
};
export type CollectionSettingsRequest = {
    revision: number;
    code_payload: string;
    order_ttl_seconds: number;
    amount_offset_maximum_cents: number;
};
export type ProviderSettingsRequest = {
    revision: number;
    environment: 'PRODUCTION' | 'SANDBOX';
    app_id: string;
    private_key?: string;
    platform_public_key?: string;
    timeout_milliseconds: number;
    scan_interval_seconds: number;
    safety_lag_seconds: number;
    maximum_success_age_seconds: number;
};
export type NotificationSettingsRequest = {
    revision: number;
    enabled: boolean;
    allowed_origin?: string;
    timeout_milliseconds: number;
    maximum_attempts: number;
    retry_base_seconds: number;
    retry_maximum_seconds: number;
};
export type AdvancedSettingsRequest = {
    revision: number;
    checkout_key_rotation_days: number;
    checkout_terminal_observation_seconds: number;
};
export type BackupSettingsRequest = {
    revision: number;
    interval_seconds: number;
    keep_count: number;
};
export type SettingsRevisionRequest = {
    revision: number;
};
export type ApiSecretRotationEnvelope = {
    data: {
        settings: RuntimeSettings;
        client_id: 'default';
        secret: string;
    };
};
export type ProviderApplicationKeyGenerationEnvelope = {
    data: {
        created: boolean;
        settings: RuntimeSettings;
        public_key: string;
        fingerprint: Sha256Fingerprint;
    };
};
export type SecretRevealEnvelope = {
    data: {
        name: RuntimeSecretName;
        value: string;
    };
};
export type AdminOrderPageEnvelope = {
    data: Array<AdminOrderSummary>;
    page: {
        next_cursor: string | null;
    };
};
export type AdminOrderDetailEnvelope = {
    data: AdminOrderDetail;
};
export type AdminOrderSummary = {
    order_id: ResourceId;
    api_client_id: string;
    merchant_order_no: MerchantOrderNumber;
    requested_amount_cents: number;
    payable_amount_cents: number;
    received_amount_cents: number | null;
    currency: 'CNY';
    product_name: string;
    checkout: CheckoutState;
    payment: PaymentState;
    refund: RefundState;
    eligible_from: string;
    created_at: string;
    updated_at: string;
    version: number;
};
export type AdminOrderDetail = {
    order_id: ResourceId;
    api_client_id: string;
    merchant_order_no: MerchantOrderNumber;
    requested_amount_cents: number;
    payable_amount_cents: number;
    received_amount_cents: number | null;
    currency: 'CNY';
    product_name: string;
    note: string | null;
    checkout: CheckoutState;
    payment: PaymentState;
    refund: RefundState;
    eligible_from: string;
    notification: OrderNotification;
    events: Array<AdminOrderEvent>;
    reconciliation: AdminOrderReconciliation;
    created_at: string;
    updated_at: string;
    version: number;
};
export type AdminOrderEvent = {
    event_id: ResourceId;
    sequence: number;
    event_type: 'CREATED' | 'CHECKOUT_CLOSED' | 'CHECKOUT_EXPIRED' | 'PAYMENT_CONFIRMED' | 'PAYMENT_DISPUTED' | 'REFUND_UPDATED';
    occurred_at: string;
    details: {
        [key: string]: unknown;
    };
};
export type AdminOrderReconciliation = {
    matches: Array<PaymentMatchDetail>;
    exceptions: Array<FinancialException>;
};
export type MerchantOrderNumber = string;
export type NotifyUrl = string;
export type ReturnUrl = string;
export type CreateOrderRequest = {
    idempotency_key: string;
    merchant_order_no: MerchantOrderNumber;
    amount_cents: number;
    product_name: string;
    note?: string | null;
    notify_url?: NotifyUrl;
    return_url?: ReturnUrl;
};
export type AdminTestPaymentRequest = {
    test_payment_id: string;
    amount_cents: number;
};
export type OrderEnvelope = {
    data: Order;
};
export type Order = {
    order_id: string;
    merchant_order_no: MerchantOrderNumber;
    requested_amount_cents: number;
    payable_amount_cents: number;
    received_amount_cents: number | null;
    currency: 'CNY';
    product_name: string;
    note: string | null;
    return_url: ReturnUrl | null;
    checkout: AuthenticatedCheckoutState;
    payment: PaymentState;
    refund: RefundState;
    notification: OrderNotification;
    created_at: string;
    updated_at: string;
    version: number;
};
export type OrderNotification = {
    notify_url: NotifyUrl | null;
};
export type AuthenticatedCheckoutState = {
    status: CheckoutStatus;
    token: string;
    state_url: string;
    checkout_url: string;
    expires_at: string;
    closed_at: string | null;
};
export type CheckoutState = {
    status: CheckoutStatus;
    expires_at: string;
    closed_at: string | null;
};
export type CheckoutStatus = 'OPEN' | 'EXPIRED' | 'CLOSED';
export type PaymentStatus = 'UNPAID' | 'CONFIRMED' | 'DISPUTED';
export type PaymentState = {
    status: PaymentStatus;
    basis: 'NONE' | 'INFERRED' | 'MANUAL';
    received_amount_cents: number | null;
};
export type RefundState = {
    status: 'NONE' | 'PARTIAL' | 'FULL';
};
export type PublicCheckoutEnvelope = {
    data: {
        merchant_order_no: MerchantOrderNumber;
        requested_amount_cents: number;
        currency: 'CNY';
        product_name: string;
        return_url: ReturnUrl | null;
        payment_instructions: PublicPaymentInstructions | null;
        checkout: CheckoutState;
        payment: PaymentState;
        refund: RefundState;
    };
};
export type PublicPaymentInstructions = {
    payable_amount_cents: number;
    currency: 'CNY';
    collection_code_payload: string;
};
export type FinancialDecisionRequest = {
    financial_operation_id: ResourceId;
    reason: string;
};
export type LinkedFinancialDecisionRequest = {
    financial_operation_id: ResourceId;
    reason: string;
    order_id: ResourceId;
    ledger_entry_id: ResourceId;
};
export type LedgerConflictType = 'RAW_PAGE_VARIANT' | 'DUPLICATE_EXTERNAL_ID' | 'MISSING_EXTERNAL_ID' | 'INVALID_AMOUNT' | 'INVALID_TIMESTAMP' | 'INVALID_DIRECTION' | 'INVALID_SHAPE';
export type LedgerConflictResolutionRequest = {
    conflict_operation_id: ResourceId;
    action: 'KEEP_EXISTING' | 'ACKNOWLEDGE_ISOLATED';
    reason: string;
};
export type LedgerConflictPageEnvelope = {
    data: Array<LedgerConflict>;
    page: {
        next_cursor: string | null;
    };
};
export type LedgerConflictDetailEnvelope = {
    data: LedgerConflictDetail;
};
export type LedgerConflictResolutionEnvelope = {
    data: {
        conflict: LedgerConflict;
        operation: LedgerConflictOperation;
        replayed: boolean;
    };
};
export type LedgerConflict = {
    conflict_id: ResourceId;
    provider_account_key: string;
    conflict_type: LedgerConflictType;
    raw_page_id: ResourceId | null;
    raw_event_id: ResourceId | null;
    existing_ledger_entry_id: ResourceId | null;
    external_event_id: string | null;
    existing_semantic_fingerprint: Sha256Fingerprint | null;
    incoming_semantic_fingerprint: Sha256Fingerprint | null;
    details: {
        [key: string]: unknown;
    };
    status: 'OPEN' | 'RESOLVED' | 'IGNORED';
    resolution: {
        [key: string]: unknown;
    } | null;
    resolution_action: 'CONFIRM_VARIANT' | 'KEEP_EXISTING' | 'ACKNOWLEDGE_ISOLATED' | null;
    resolution_operation_id: ResourceId | null;
    resolution_fingerprint: Sha256Fingerprint | null;
    conflict_fingerprint: Sha256Fingerprint;
    created_at: string;
    resolved_at: string | null;
};
export type LedgerConflictDetail = {
    conflict: LedgerConflict;
    raw_page: LedgerConflictRawPage | null;
    incoming_event: LedgerConflictIncomingEvent | null;
    existing_ledger_entry: LedgerConflictExistingEntry | null;
    resolution_operation: LedgerConflictOperation | null;
};
export type LedgerConflictRawPage = {
    raw_page_id: ResourceId;
    ingest_run_id: ResourceId;
    provider_account_key: string;
    window_start: string;
    window_end: string;
    page_no: number;
    page_size: number;
    total_size: number;
    has_more: boolean;
    request_fingerprint: Sha256Fingerprint;
    response_fingerprint: Sha256Fingerprint;
    http_status: number;
    signature_verified: boolean;
    trace_id: string | null;
    received_at: string;
};
export type LedgerConflictIncomingEvent = {
    raw_event_id: ResourceId;
    raw_page_id: ResourceId;
    provider_account_key: string;
    ordinal: number;
    external_event_id: string | null;
    occurred_at_text: string | null;
    amount_text: string | null;
    direction_text: string | null;
    alipay_order_no: string | null;
    merchant_order_no: string | null;
    trans_memo: string | null;
    other_account: string | null;
    payload_fingerprint: Sha256Fingerprint;
    observed_at: string;
};
export type LedgerConflictExistingEntry = {
    ledger_entry_id: ResourceId;
    provider_account_key: string;
    raw_event_id: ResourceId;
    external_event_id: string;
    semantic_fingerprint: Sha256Fingerprint;
    occurred_at: string;
    occurred_at_precision_milliseconds: 1 | 10 | 100 | 1000;
    amount_cents: number;
    direction: 'CREDIT' | 'DEBIT';
    currency: 'CNY';
    alipay_order_no: string | null;
    merchant_order_no: string | null;
    trans_memo: string | null;
    other_account: string | null;
    state: 'UNALLOCATED' | 'CANDIDATE' | 'ALLOCATED' | 'CONFLICT' | 'ISOLATED' | 'IGNORED';
    created_at: string;
    updated_at: string;
};
export type LedgerConflictOperation = {
    conflict_operation_id: ResourceId;
    operation_key: string;
    conflict_id: ResourceId;
    request_fingerprint: Sha256Fingerprint;
    action: 'CONFIRM_VARIANT' | 'KEEP_EXISTING' | 'ACKNOWLEDGE_ISOLATED';
    actor_type: 'SYSTEM' | 'ADMIN';
    actor_id: string | null;
    reason: string;
    created_at: string;
};
export type MatchCandidateEnvelope = {
    data: MatchCandidate;
};
export type MatchCandidateListEnvelope = {
    data: Array<MatchCandidate>;
};
export type MatchCandidate = {
    candidate_id: ResourceId;
    ledger_entry_id: ResourceId;
    order_id: ResourceId;
    slot_id: ResourceId;
    evidence_type: 'AMOUNT_INFERRED';
    rule_version: 3;
    evidence: {
        [key: string]: unknown;
    };
    candidate_fingerprint: Sha256Fingerprint;
    status: 'ELIGIBLE' | 'SELECTED' | 'SUPERSEDED';
    decided_by_operation_id: ResourceId | null;
    created_at: string;
    updated_at: string;
    decided_at: string | null;
};
export type PaymentMatchEnvelope = {
    data: PaymentMatchDetail;
};
export type PaymentMatchPageEnvelope = {
    data: Array<PaymentMatchDetail>;
    page: {
        next_cursor: string | null;
    };
};
export type PaymentMatch = {
    payment_match_id: ResourceId;
    ledger_entry_id: ResourceId;
    order_id: ResourceId;
    candidate_id: ResourceId | null;
    evidence_type: 'AMOUNT_INFERRED' | 'MANUAL';
    evidence: {
        [key: string]: unknown;
    };
    status: 'SETTLED' | 'REVERSED';
    created_by_operation_id: ResourceId;
    resolved_by_operation_id: ResourceId | null;
    created_at: string;
    updated_at: string;
    resolved_at: string | null;
};
export type PaymentMatchDetail = {
    payment_match_id: ResourceId;
    ledger_entry_id: ResourceId;
    order_id: ResourceId;
    candidate_id: ResourceId | null;
    evidence_type: 'AMOUNT_INFERRED' | 'MANUAL';
    evidence: {
        [key: string]: unknown;
    };
    status: 'SETTLED' | 'REVERSED';
    created_by_operation_id: ResourceId;
    resolved_by_operation_id: ResourceId | null;
    created_at: string;
    updated_at: string;
    resolved_at: string | null;
    candidate: MatchCandidate | null;
    ledger_entry: ReconciliationLedgerEntry;
    order: ReconciliationOrder;
};
export type ReconciliationLedgerEntryEnvelope = {
    data: ReconciliationLedgerEntry;
};
export type ReconciliationLedgerEntry = {
    ledger_entry_id: ResourceId;
    external_event_id: string;
    semantic_fingerprint: Sha256Fingerprint;
    occurred_at: string;
    occurred_at_precision_milliseconds: 1 | 10 | 100 | 1000;
    occurred_at_interval_end_exclusive: string;
    amount_cents: number;
    direction: 'CREDIT' | 'DEBIT';
    currency: 'CNY';
    provider_order_no: string | null;
    merchant_order_no: string | null;
    memo: string | null;
    other_account: string | null;
    state: 'UNALLOCATED' | 'CANDIDATE' | 'ALLOCATED' | 'CONFLICT' | 'ISOLATED' | 'IGNORED';
    created_at: string;
    updated_at: string;
};
export type ReconciliationOrder = {
    order_id: ResourceId;
    merchant_order_no: string;
    requested_amount_cents: number;
    payable_amount_cents: number;
    received_amount_cents: number | null;
    currency: 'CNY';
    product_name: string;
    note: string | null;
    checkout_status: 'OPEN' | 'EXPIRED' | 'CLOSED';
    payment_status: 'UNPAID' | 'CONFIRMED' | 'DISPUTED';
    payment_basis: 'NONE' | 'INFERRED' | 'MANUAL';
    refund_status: 'NONE' | 'PARTIAL' | 'FULL';
    eligible_from: string;
    created_at: string;
    expires_at: string;
    closed_at: string | null;
    updated_at: string;
    version: number;
};
export type FinancialOperation = {
    financial_operation_id: ResourceId;
    operation_type: 'AUTO_SETTLEMENT' | 'SUPERSEDE_CANDIDATE' | 'MANUAL_SETTLEMENT' | 'REVERSE_SETTLEMENT' | 'RECORD_REFUND';
    actor_type: 'SYSTEM' | 'ADMIN';
    actor_id: string | null;
    order_id: ResourceId | null;
    ledger_entry_id: ResourceId | null;
    reverses_operation_id: ResourceId | null;
    reason: string | null;
    request_fingerprint: Sha256Fingerprint;
    created_at: string;
};
export type FinancialDecisionEnvelope = {
    data: {
        operation: FinancialOperation;
        payment_match: PaymentMatch;
        order_id: ResourceId;
        ledger_entry_id: ResourceId;
        order_version: number;
        replayed: boolean;
    };
};
export type RefundDecisionEnvelope = {
    data: {
        operation: FinancialOperation;
        refund_record_id: ResourceId;
        order_id: ResourceId;
        ledger_entry_id: ResourceId;
        refund_status: 'PARTIAL' | 'FULL';
        order_version: number;
        replayed: boolean;
    };
};
export type FinancialExceptionEnvelope = {
    data: FinancialException;
};
export type FinancialExceptionPageEnvelope = {
    data: Array<FinancialException>;
    page: {
        next_cursor: string | null;
    };
};
export type FinancialException = {
    exception_id: ResourceId;
    provider_account_key: string;
    exception_type: 'UNMATCHED_CREDIT' | 'UNMATCHED_DEBIT' | 'AMBIGUOUS_MATCH' | 'CHECKOUT_ENDED_PAYMENT' | 'DUPLICATE_PAYMENT' | 'AMOUNT_MISMATCH' | 'UNLINKED_REFUND' | 'RECONCILIATION_CONFLICT';
    ledger_entry_id: ResourceId | null;
    order_id: ResourceId | null;
    candidate_id: ResourceId | null;
    context_key: string;
    details: {
        [key: string]: unknown;
    };
    exception_fingerprint: Sha256Fingerprint;
    status: 'OPEN' | 'RESOLVED';
    resolution_operation_id: ResourceId | null;
    resolution: {
        [key: string]: unknown;
    } | null;
    created_at: string;
    resolved_at: string | null;
};
export type WebhookDeliveryStatus = 'PENDING' | 'LEASED' | 'RETRY_WAIT' | 'ACKNOWLEDGED' | 'DEAD_LETTER';
export type WebhookAttemptOutcome = 'STARTED' | 'ACKNOWLEDGED' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE' | 'OUTCOME_UNKNOWN';
export type WebhookPayload = {
    schema: string;
    event_id: ResourceId;
    event_type: string;
    financial_operation_id?: ResourceId;
    order_id: ResourceId;
    merchant_order_no: MerchantOrderNumber;
    product_name: string;
    note: string | null;
    requested_amount_cents?: number;
    payable_amount_cents?: number;
    received_amount_cents?: number;
    currency?: 'CNY';
    payment_status?: 'UNPAID' | 'CONFIRMED' | 'DISPUTED';
    payment_basis?: 'NONE' | 'INFERRED' | 'MANUAL';
    refund_status?: 'NONE' | 'PARTIAL' | 'FULL';
    event_details?: {
        [key: string]: unknown;
    };
    order_version: number;
    occurred_at?: number;
    [key: string]: unknown;
};
export type WebhookAcknowledgement = {
    schema: 'perpay:webhook-ack:v1';
    ack: true;
    event_id: ResourceId;
    delivery_id: ResourceId;
};
export type WebhookEventEnvelope = {
    data: WebhookEvent;
};
export type WebhookEvent = {
    event_id: ResourceId;
    event_type: string;
    order_id: ResourceId;
    order_version: number;
    payload: WebhookPayload;
    payload_fingerprint: Sha256Fingerprint;
    created_at: string;
};
export type WebhookDeliveryFields = {
    delivery_id: ResourceId;
    event_id: ResourceId;
    target_id: ResourceId;
    generation: number;
    predecessor_delivery_id: ResourceId | null;
    request_key: ResourceId;
    requested_by_type: 'SYSTEM' | 'ADMIN';
    requested_by_actor_id: string | null;
    reason: string | null;
    status: WebhookDeliveryStatus;
    attempt_count: number;
    next_attempt_at: string | null;
    lease_expires_at: string | null;
    acknowledged_at: string | null;
    dead_lettered_at: string | null;
    last_error_code: string | null;
    created_at: string;
    updated_at: string;
};
export type WebhookDelivery = WebhookDeliveryFields;
export type WebhookDeliverySummary = WebhookDeliveryFields & {
    event: {
        event_type: string;
        order_id: ResourceId;
    };
    target: {
        format: 'NATIVE_JSON_V1';
        url_fingerprint: Sha256Fingerprint;
    };
};
export type WebhookDeliveryPageEnvelope = {
    data: Array<WebhookDeliverySummary>;
    page: {
        next_cursor: string | null;
    };
};
export type WebhookTarget = {
    target_id: ResourceId;
    order_id: ResourceId;
    api_client_id: string;
    format: 'NATIVE_JSON_V1';
    target_url: NotifyUrl;
    allowed_origin: string;
    url_fingerprint: Sha256Fingerprint;
    created_at: string;
};
export type WebhookDeliveryDetail = {
    delivery: WebhookDelivery;
    event: WebhookEvent;
    target: WebhookTarget;
};
export type WebhookDeliveryDetailEnvelope = {
    data: WebhookDeliveryDetail;
};
export type OrderWebhookDeliveryDetail = {
    delivery: WebhookDelivery;
    event: WebhookEvent;
    target: WebhookTarget;
    attempts: Array<WebhookAttempt>;
};
export type OrderWebhookDeliveryPageEnvelope = {
    data: Array<OrderWebhookDeliveryDetail>;
    page: {
        next_cursor: string | null;
    };
};
export type WebhookAttempt = {
    attempt_id: ResourceId;
    delivery_id: ResourceId;
    attempt_number: number;
    key_version: number;
    key_id: ResourceId;
    request_timestamp: number;
    request_body_fingerprint: Sha256Fingerprint;
    outcome: WebhookAttemptOutcome;
    resolved_addresses_fingerprint: Sha256Fingerprint | null;
    connected_address: string | null;
    http_status: number | null;
    response_bytes: number | null;
    response_fingerprint: Sha256Fingerprint | null;
    ack_code: string | null;
    error_code: string | null;
    started_at: string;
    finished_at: string | null;
};
export type WebhookAttemptListEnvelope = {
    data: Array<WebhookAttempt>;
};
export type WebhookRedeliveryRequest = {
    redelivery_id: ResourceId;
    reason: string;
};
export type WebhookRedeliveryEnvelope = {
    data: {
        delivery: WebhookDelivery;
        replayed: boolean;
    };
};
export type Sha256Fingerprint = string;
export type ErrorCode = 'amount_slots_exhausted' | 'api_authentication_failed' | 'api_client_invalid' | 'api_nonce_replayed' | 'asset_not_found' | 'auth_rate_limited' | 'candidate_not_found' | 'candidate_set_changed' | 'checkout_code_generation_failed' | 'checkout_code_not_found' | 'checkout_not_found' | 'csrf_invalid' | 'duplicate_json_key' | 'event_not_found' | 'financial_clock_unavailable' | 'financial_exception_not_found' | 'forwarded_header_invalid' | 'idempotency_conflict' | 'identity_already_initialized' | 'identity_not_initialized' | 'internal_error' | 'invalid_content_length' | 'invalid_credentials' | 'invalid_json' | 'ledger_conflict_action_not_allowed' | 'ledger_conflict_not_found' | 'ledger_conflict_operation_conflict' | 'ledger_conflict_state_conflict' | 'ledger_entry_not_found' | 'ledger_unavailable' | 'match_not_found' | 'match_state_conflict' | 'merchant_order_no_conflict' | 'operation_conflict' | 'order_clock_unavailable' | 'order_not_found' | 'origin_not_allowed' | 'password_unchanged' | 'password_work_busy' | 'provider_application_key_missing' | 'provider_application_key_rotation_not_supported' | 'provider_switch_blocked' | 'public_checkout_rate_limited' | 'reconciliation_not_ready' | 'reconciliation_unavailable' | 'request_body_too_large' | 'request_body_unreadable' | 'return_url_invalid' | 'return_url_not_allowed' | 'route_not_found' | 'secret_not_found' | 'session_invalid' | 'settings_not_configured' | 'settings_revision_conflict' | 'settings_unavailable' | 'settings_validation_failed' | 'system_not_configured' | 'system_not_ready' | 'unsupported_media_type' | 'update_check_unavailable' | 'validation_failed' | 'webhook_delivery_not_found' | 'webhook_delivery_state_conflict' | 'webhook_disabled' | 'webhook_event_not_found' | 'webhook_operation_conflict' | 'webhook_signing_key_rollback' | 'webhook_signing_key_unavailable' | 'webhook_target_inactive' | 'webhook_target_invalid' | 'webhook_target_not_allowed' | 'webhook_unavailable';
export type ErrorEnvelope = {
    error: {
        code: ErrorCode;
        message: string;
        request_id: string;
        fields?: {
            [key: string]: string;
        };
    };
};
export type RequestId = string;
export type OrderId = ResourceId;
export type AdminOrigin = string;
export type RuntimeSecretName2 = RuntimeSecretName;
export type CandidateId = ResourceId;
export type LedgerEntryId = ResourceId;
export type PaymentMatchId = ResourceId;
export type ExceptionId = ResourceId;
export type ConflictId = ResourceId;
export type WebhookEventId = ResourceId;
export type WebhookDeliveryId = ResourceId;
export type WebhookProtocolVersionHeader = '1';
export type WebhookKeyIdHeader = ResourceId;
export type WebhookTimestampHeader = string;
export type WebhookDeliveryIdHeader = ResourceId;
export type WebhookEventIdHeader = ResourceId;
export type WebhookAttemptHeader = string;
export type FinancialDecision = FinancialDecisionRequest;
export type LinkedFinancialDecision = LinkedFinancialDecisionRequest;
export type SetupAdministratorData = {
    body: AdminSetupRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/setup';
};
export type SetupAdministratorErrors = {
    400: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    429: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type SetupAdministratorError = SetupAdministratorErrors[keyof SetupAdministratorErrors];
export type SetupAdministratorResponses = {
    204: void;
};
export type SetupAdministratorResponse = SetupAdministratorResponses[keyof SetupAdministratorResponses];
export type LoginAdministratorData = {
    body: AdminLoginRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/session/login';
};
export type LoginAdministratorErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    429: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type LoginAdministratorError = LoginAdministratorErrors[keyof LoginAdministratorErrors];
export type LoginAdministratorResponses = {
    200: AdminLoginEnvelope;
};
export type LoginAdministratorResponse = LoginAdministratorResponses[keyof LoginAdministratorResponses];
export type GetAdministratorSessionData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/session';
};
export type GetAdministratorSessionErrors = {
    401: ErrorEnvelope;
};
export type GetAdministratorSessionError = GetAdministratorSessionErrors[keyof GetAdministratorSessionErrors];
export type GetAdministratorSessionResponses = {
    200: AdminSessionEnvelope;
};
export type GetAdministratorSessionResponse = GetAdministratorSessionResponses[keyof GetAdministratorSessionResponses];
export type GetAdministratorSystemStatusData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/system/status';
};
export type GetAdministratorSystemStatusErrors = {
    401: ErrorEnvelope;
};
export type GetAdministratorSystemStatusError = GetAdministratorSystemStatusErrors[keyof GetAdministratorSystemStatusErrors];
export type GetAdministratorSystemStatusResponses = {
    200: SystemStatusEnvelope;
};
export type GetAdministratorSystemStatusResponse = GetAdministratorSystemStatusResponses[keyof GetAdministratorSystemStatusResponses];
export type CheckOfficialUpdateData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/system/update';
};
export type CheckOfficialUpdateErrors = {
    401: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type CheckOfficialUpdateError = CheckOfficialUpdateErrors[keyof CheckOfficialUpdateErrors];
export type CheckOfficialUpdateResponses = {
    200: OfficialUpdateEnvelope;
};
export type CheckOfficialUpdateResponse = CheckOfficialUpdateResponses[keyof CheckOfficialUpdateResponses];
export type GetAdministratorSystemAnalyticsData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: {
        range?: 7 | 30 | 90;
    };
    url: '/api/admin/v1/system/analytics';
};
export type GetAdministratorSystemAnalyticsErrors = {
    401: ErrorEnvelope;
    422: ErrorEnvelope;
};
export type GetAdministratorSystemAnalyticsError = GetAdministratorSystemAnalyticsErrors[keyof GetAdministratorSystemAnalyticsErrors];
export type GetAdministratorSystemAnalyticsResponses = {
    200: SystemAnalyticsEnvelope;
};
export type GetAdministratorSystemAnalyticsResponse = GetAdministratorSystemAnalyticsResponses[keyof GetAdministratorSystemAnalyticsResponses];
export type ListAdministratorWorkItemsData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: {
        type?: AdminWorkItemTypeFilter;
        limit?: number;
        cursor?: string;
    };
    url: '/api/admin/v1/work-items';
};
export type ListAdministratorWorkItemsErrors = {
    401: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListAdministratorWorkItemsError = ListAdministratorWorkItemsErrors[keyof ListAdministratorWorkItemsErrors];
export type ListAdministratorWorkItemsResponses = {
    200: AdminWorkItemPageEnvelope;
};
export type ListAdministratorWorkItemsResponse = ListAdministratorWorkItemsResponses[keyof ListAdministratorWorkItemsResponses];
export type LogoutAdministratorSessionData = {
    body: AdminEmptyRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/session/logout';
};
export type LogoutAdministratorSessionErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type LogoutAdministratorSessionError = LogoutAdministratorSessionErrors[keyof LogoutAdministratorSessionErrors];
export type LogoutAdministratorSessionResponses = {
    204: void;
};
export type LogoutAdministratorSessionResponse = LogoutAdministratorSessionResponses[keyof LogoutAdministratorSessionResponses];
export type RevokeAllAdministratorSessionsData = {
    body: AdminEmptyRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/sessions/revoke-all';
};
export type RevokeAllAdministratorSessionsErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type RevokeAllAdministratorSessionsError = RevokeAllAdministratorSessionsErrors[keyof RevokeAllAdministratorSessionsErrors];
export type RevokeAllAdministratorSessionsResponses = {
    200: AdminRevokeAllEnvelope;
};
export type RevokeAllAdministratorSessionsResponse = RevokeAllAdministratorSessionsResponses[keyof RevokeAllAdministratorSessionsResponses];
export type ChangeAdministratorPasswordData = {
    body: AdminPasswordChangeRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/password';
};
export type ChangeAdministratorPasswordErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ChangeAdministratorPasswordError = ChangeAdministratorPasswordErrors[keyof ChangeAdministratorPasswordErrors];
export type ChangeAdministratorPasswordResponses = {
    204: void;
};
export type ChangeAdministratorPasswordResponse = ChangeAdministratorPasswordResponses[keyof ChangeAdministratorPasswordResponses];
export type GetRuntimeSettingsData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/settings';
};
export type GetRuntimeSettingsErrors = {
    401: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetRuntimeSettingsError = GetRuntimeSettingsErrors[keyof GetRuntimeSettingsErrors];
export type GetRuntimeSettingsResponses = {
    200: RuntimeSettingsEnvelope;
};
export type GetRuntimeSettingsResponse = GetRuntimeSettingsResponses[keyof GetRuntimeSettingsResponses];
export type CreateAdministratorTestPaymentData = {
    body: AdminTestPaymentRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/test-payments';
};
export type CreateAdministratorTestPaymentErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type CreateAdministratorTestPaymentError = CreateAdministratorTestPaymentErrors[keyof CreateAdministratorTestPaymentErrors];
export type CreateAdministratorTestPaymentResponses = {
    200: OrderEnvelope;
    201: OrderEnvelope;
};
export type CreateAdministratorTestPaymentResponse = CreateAdministratorTestPaymentResponses[keyof CreateAdministratorTestPaymentResponses];
export type UpdateCollectionSettingsData = {
    body: CollectionSettingsRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/settings/collection';
};
export type UpdateCollectionSettingsErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type UpdateCollectionSettingsError = UpdateCollectionSettingsErrors[keyof UpdateCollectionSettingsErrors];
export type UpdateCollectionSettingsResponses = {
    200: RuntimeSettingsEnvelope;
};
export type UpdateCollectionSettingsResponse = UpdateCollectionSettingsResponses[keyof UpdateCollectionSettingsResponses];
export type UpdateProviderSettingsData = {
    body: ProviderSettingsRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/settings/provider';
};
export type UpdateProviderSettingsErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type UpdateProviderSettingsError = UpdateProviderSettingsErrors[keyof UpdateProviderSettingsErrors];
export type UpdateProviderSettingsResponses = {
    200: RuntimeSettingsEnvelope;
};
export type UpdateProviderSettingsResponse = UpdateProviderSettingsResponses[keyof UpdateProviderSettingsResponses];
export type GenerateProviderApplicationKeyData = {
    body: SettingsRevisionRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/settings/provider/application-key/actions/generate';
};
export type GenerateProviderApplicationKeyErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GenerateProviderApplicationKeyError = GenerateProviderApplicationKeyErrors[keyof GenerateProviderApplicationKeyErrors];
export type GenerateProviderApplicationKeyResponses = {
    200: ProviderApplicationKeyGenerationEnvelope;
    201: ProviderApplicationKeyGenerationEnvelope;
};
export type GenerateProviderApplicationKeyResponse = GenerateProviderApplicationKeyResponses[keyof GenerateProviderApplicationKeyResponses];
export type UpdateNotificationSettingsData = {
    body: NotificationSettingsRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/settings/notifications';
};
export type UpdateNotificationSettingsErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type UpdateNotificationSettingsError = UpdateNotificationSettingsErrors[keyof UpdateNotificationSettingsErrors];
export type UpdateNotificationSettingsResponses = {
    200: RuntimeSettingsEnvelope;
};
export type UpdateNotificationSettingsResponse = UpdateNotificationSettingsResponses[keyof UpdateNotificationSettingsResponses];
export type UpdateAdvancedSettingsData = {
    body: AdvancedSettingsRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/settings/advanced';
};
export type UpdateAdvancedSettingsErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type UpdateAdvancedSettingsError = UpdateAdvancedSettingsErrors[keyof UpdateAdvancedSettingsErrors];
export type UpdateAdvancedSettingsResponses = {
    200: RuntimeSettingsEnvelope;
};
export type UpdateAdvancedSettingsResponse = UpdateAdvancedSettingsResponses[keyof UpdateAdvancedSettingsResponses];
export type RotateApiClientSecretData = {
    body: SettingsRevisionRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/settings/api-key/actions/rotate';
};
export type RotateApiClientSecretErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type RotateApiClientSecretError = RotateApiClientSecretErrors[keyof RotateApiClientSecretErrors];
export type RotateApiClientSecretResponses = {
    201: ApiSecretRotationEnvelope;
};
export type RotateApiClientSecretResponse = RotateApiClientSecretResponses[keyof RotateApiClientSecretResponses];
export type UpdateBackupSettingsData = {
    body: BackupSettingsRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/settings/backup';
};
export type UpdateBackupSettingsErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type UpdateBackupSettingsError = UpdateBackupSettingsErrors[keyof UpdateBackupSettingsErrors];
export type UpdateBackupSettingsResponses = {
    200: RuntimeSettingsEnvelope;
};
export type UpdateBackupSettingsResponse = UpdateBackupSettingsResponses[keyof UpdateBackupSettingsResponses];
export type RevealRuntimeSecretData = {
    body: {
        [key: string]: never;
    };
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path: {
        name: RuntimeSecretName;
    };
    query?: never;
    url: '/api/admin/v1/settings/secrets/{name}/actions/reveal';
};
export type RevealRuntimeSecretErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    404: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type RevealRuntimeSecretError = RevealRuntimeSecretErrors[keyof RevealRuntimeSecretErrors];
export type RevealRuntimeSecretResponses = {
    200: SecretRevealEnvelope;
};
export type RevealRuntimeSecretResponse = RevealRuntimeSecretResponses[keyof RevealRuntimeSecretResponses];
export type ListAdministratorOrdersData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: {
        checkout_status?: CheckoutStatus;
        payment_status?: PaymentStatus;
        limit?: number;
        cursor?: string;
    };
    url: '/api/admin/v1/orders';
};
export type ListAdministratorOrdersErrors = {
    401: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListAdministratorOrdersError = ListAdministratorOrdersErrors[keyof ListAdministratorOrdersErrors];
export type ListAdministratorOrdersResponses = {
    200: AdminOrderPageEnvelope;
};
export type ListAdministratorOrdersResponse = ListAdministratorOrdersResponses[keyof ListAdministratorOrdersResponses];
export type GetAdministratorOrderByMerchantNumberData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        merchantOrderNo: MerchantOrderNumber;
    };
    query?: never;
    url: '/api/admin/v1/orders/by-merchant-no/{merchantOrderNo}';
};
export type GetAdministratorOrderByMerchantNumberErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetAdministratorOrderByMerchantNumberError = GetAdministratorOrderByMerchantNumberErrors[keyof GetAdministratorOrderByMerchantNumberErrors];
export type GetAdministratorOrderByMerchantNumberResponses = {
    200: AdminOrderDetailEnvelope;
};
export type GetAdministratorOrderByMerchantNumberResponse = GetAdministratorOrderByMerchantNumberResponses[keyof GetAdministratorOrderByMerchantNumberResponses];
export type GetAdministratorOrderData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        orderId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/orders/{orderId}';
};
export type GetAdministratorOrderErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetAdministratorOrderError = GetAdministratorOrderErrors[keyof GetAdministratorOrderErrors];
export type GetAdministratorOrderResponses = {
    200: AdminOrderDetailEnvelope;
};
export type GetAdministratorOrderResponse = GetAdministratorOrderResponses[keyof GetAdministratorOrderResponses];
export type ListAdministratorOrderWebhookDeliveriesData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        orderId: ResourceId;
    };
    query?: {
        limit?: number;
        cursor?: string;
    };
    url: '/api/admin/v1/orders/{orderId}/notifications/deliveries';
};
export type ListAdministratorOrderWebhookDeliveriesErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListAdministratorOrderWebhookDeliveriesError = ListAdministratorOrderWebhookDeliveriesErrors[keyof ListAdministratorOrderWebhookDeliveriesErrors];
export type ListAdministratorOrderWebhookDeliveriesResponses = {
    200: OrderWebhookDeliveryPageEnvelope;
};
export type ListAdministratorOrderWebhookDeliveriesResponse = ListAdministratorOrderWebhookDeliveriesResponses[keyof ListAdministratorOrderWebhookDeliveriesResponses];
export type ListLedgerConflictsData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: {
        status?: 'OPEN' | 'RESOLVED' | 'IGNORED' | 'ALL';
        limit?: number;
        cursor?: string;
    };
    url: '/api/admin/v1/ledger/conflicts';
};
export type ListLedgerConflictsErrors = {
    401: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListLedgerConflictsError = ListLedgerConflictsErrors[keyof ListLedgerConflictsErrors];
export type ListLedgerConflictsResponses = {
    200: LedgerConflictPageEnvelope;
};
export type ListLedgerConflictsResponse = ListLedgerConflictsResponses[keyof ListLedgerConflictsResponses];
export type GetLedgerConflictData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        conflictId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/ledger/conflicts/{conflictId}';
};
export type GetLedgerConflictErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetLedgerConflictError = GetLedgerConflictErrors[keyof GetLedgerConflictErrors];
export type GetLedgerConflictResponses = {
    200: LedgerConflictDetailEnvelope;
};
export type GetLedgerConflictResponse = GetLedgerConflictResponses[keyof GetLedgerConflictResponses];
export type ResolveLedgerConflictData = {
    body: LedgerConflictResolutionRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path: {
        conflictId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/ledger/conflicts/{conflictId}/actions/resolve';
};
export type ResolveLedgerConflictErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    404: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ResolveLedgerConflictError = ResolveLedgerConflictErrors[keyof ResolveLedgerConflictErrors];
export type ResolveLedgerConflictResponses = {
    200: LedgerConflictResolutionEnvelope;
    201: LedgerConflictResolutionEnvelope;
};
export type ResolveLedgerConflictResponse = ResolveLedgerConflictResponses[keyof ResolveLedgerConflictResponses];
export type GetReconciliationCandidateData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        candidateId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/reconciliation/candidates/{candidateId}';
};
export type GetReconciliationCandidateErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetReconciliationCandidateError = GetReconciliationCandidateErrors[keyof GetReconciliationCandidateErrors];
export type GetReconciliationCandidateResponses = {
    200: MatchCandidateEnvelope;
};
export type GetReconciliationCandidateResponse = GetReconciliationCandidateResponses[keyof GetReconciliationCandidateResponses];
export type GetReconciliationLedgerEntryData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        ledgerEntryId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/reconciliation/ledger-entries/{ledgerEntryId}';
};
export type GetReconciliationLedgerEntryErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetReconciliationLedgerEntryError = GetReconciliationLedgerEntryErrors[keyof GetReconciliationLedgerEntryErrors];
export type GetReconciliationLedgerEntryResponses = {
    200: ReconciliationLedgerEntryEnvelope;
};
export type GetReconciliationLedgerEntryResponse = GetReconciliationLedgerEntryResponses[keyof GetReconciliationLedgerEntryResponses];
export type ListLedgerEntryCandidatesData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        ledgerEntryId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/reconciliation/ledger-entries/{ledgerEntryId}/candidates';
};
export type ListLedgerEntryCandidatesErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListLedgerEntryCandidatesError = ListLedgerEntryCandidatesErrors[keyof ListLedgerEntryCandidatesErrors];
export type ListLedgerEntryCandidatesResponses = {
    200: MatchCandidateListEnvelope;
};
export type ListLedgerEntryCandidatesResponse = ListLedgerEntryCandidatesResponses[keyof ListLedgerEntryCandidatesResponses];
export type ListPaymentMatchesData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: {
        status?: 'SETTLED' | 'REVERSED';
        limit?: number;
        cursor?: string;
    };
    url: '/api/admin/v1/reconciliation/matches';
};
export type ListPaymentMatchesErrors = {
    401: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListPaymentMatchesError = ListPaymentMatchesErrors[keyof ListPaymentMatchesErrors];
export type ListPaymentMatchesResponses = {
    200: PaymentMatchPageEnvelope;
};
export type ListPaymentMatchesResponse = ListPaymentMatchesResponses[keyof ListPaymentMatchesResponses];
export type GetPaymentMatchData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        paymentMatchId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/reconciliation/matches/{paymentMatchId}';
};
export type GetPaymentMatchErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetPaymentMatchError = GetPaymentMatchErrors[keyof GetPaymentMatchErrors];
export type GetPaymentMatchResponses = {
    200: PaymentMatchEnvelope;
};
export type GetPaymentMatchResponse = GetPaymentMatchResponses[keyof GetPaymentMatchResponses];
export type ListOpenFinancialExceptionsData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: {
        limit?: number;
        cursor?: string;
    };
    url: '/api/admin/v1/reconciliation/exceptions';
};
export type ListOpenFinancialExceptionsErrors = {
    401: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListOpenFinancialExceptionsError = ListOpenFinancialExceptionsErrors[keyof ListOpenFinancialExceptionsErrors];
export type ListOpenFinancialExceptionsResponses = {
    200: FinancialExceptionPageEnvelope;
};
export type ListOpenFinancialExceptionsResponse = ListOpenFinancialExceptionsResponses[keyof ListOpenFinancialExceptionsResponses];
export type GetFinancialExceptionData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        exceptionId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/reconciliation/exceptions/{exceptionId}';
};
export type GetFinancialExceptionErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetFinancialExceptionError = GetFinancialExceptionErrors[keyof GetFinancialExceptionErrors];
export type GetFinancialExceptionResponses = {
    200: FinancialExceptionEnvelope;
};
export type GetFinancialExceptionResponse = GetFinancialExceptionResponses[keyof GetFinancialExceptionResponses];
export type ReversePaymentSettlementData = {
    body: FinancialDecision;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path: {
        paymentMatchId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/reconciliation/matches/{paymentMatchId}/actions/reverse';
};
export type ReversePaymentSettlementErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    404: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ReversePaymentSettlementError = ReversePaymentSettlementErrors[keyof ReversePaymentSettlementErrors];
export type ReversePaymentSettlementResponses = {
    200: FinancialDecisionEnvelope;
};
export type ReversePaymentSettlementResponse = ReversePaymentSettlementResponses[keyof ReversePaymentSettlementResponses];
export type CreateManualSettlementData = {
    body: LinkedFinancialDecision;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/reconciliation/settlements/manual';
};
export type CreateManualSettlementErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    404: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type CreateManualSettlementError = CreateManualSettlementErrors[keyof CreateManualSettlementErrors];
export type CreateManualSettlementResponses = {
    200: FinancialDecisionEnvelope;
};
export type CreateManualSettlementResponse = CreateManualSettlementResponses[keyof CreateManualSettlementResponses];
export type RecordCollectedRefundDebitData = {
    body: LinkedFinancialDecision;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path?: never;
    query?: never;
    url: '/api/admin/v1/reconciliation/refunds';
};
export type RecordCollectedRefundDebitErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    404: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type RecordCollectedRefundDebitError = RecordCollectedRefundDebitErrors[keyof RecordCollectedRefundDebitErrors];
export type RecordCollectedRefundDebitResponses = {
    200: RefundDecisionEnvelope;
};
export type RecordCollectedRefundDebitResponse = RecordCollectedRefundDebitResponses[keyof RecordCollectedRefundDebitResponses];
export type ListWebhookDeliveriesData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path?: never;
    query?: {
        status?: WebhookDeliveryStatus;
        limit?: number;
        cursor?: string;
    };
    url: '/api/admin/v1/webhooks/deliveries';
};
export type ListWebhookDeliveriesErrors = {
    401: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListWebhookDeliveriesError = ListWebhookDeliveriesErrors[keyof ListWebhookDeliveriesErrors];
export type ListWebhookDeliveriesResponses = {
    200: WebhookDeliveryPageEnvelope;
};
export type ListWebhookDeliveriesResponse = ListWebhookDeliveriesResponses[keyof ListWebhookDeliveriesResponses];
export type GetWebhookDeliveryData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        deliveryId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/webhooks/deliveries/{deliveryId}';
};
export type GetWebhookDeliveryErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type GetWebhookDeliveryError = GetWebhookDeliveryErrors[keyof GetWebhookDeliveryErrors];
export type GetWebhookDeliveryResponses = {
    200: WebhookDeliveryDetailEnvelope;
};
export type GetWebhookDeliveryResponse = GetWebhookDeliveryResponses[keyof GetWebhookDeliveryResponses];
export type ListWebhookDeliveryAttemptsData = {
    body?: never;
    headers?: {
        'X-Request-Id'?: string;
    };
    path: {
        deliveryId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/webhooks/deliveries/{deliveryId}/attempts';
};
export type ListWebhookDeliveryAttemptsErrors = {
    401: ErrorEnvelope;
    404: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type ListWebhookDeliveryAttemptsError = ListWebhookDeliveryAttemptsErrors[keyof ListWebhookDeliveryAttemptsErrors];
export type ListWebhookDeliveryAttemptsResponses = {
    200: WebhookAttemptListEnvelope;
};
export type ListWebhookDeliveryAttemptsResponse = ListWebhookDeliveryAttemptsResponses[keyof ListWebhookDeliveryAttemptsResponses];
export type RedeliverWebhookDeliveryData = {
    body: WebhookRedeliveryRequest;
    headers?: {
        'X-Request-Id'?: string;
        Origin?: string;
    };
    path: {
        deliveryId: ResourceId;
    };
    query?: never;
    url: '/api/admin/v1/webhooks/deliveries/{deliveryId}/actions/redeliver';
};
export type RedeliverWebhookDeliveryErrors = {
    400: ErrorEnvelope;
    401: ErrorEnvelope;
    403: ErrorEnvelope;
    404: ErrorEnvelope;
    409: ErrorEnvelope;
    413: ErrorEnvelope;
    415: ErrorEnvelope;
    422: ErrorEnvelope;
    503: ErrorEnvelope;
};
export type RedeliverWebhookDeliveryError = RedeliverWebhookDeliveryErrors[keyof RedeliverWebhookDeliveryErrors];
export type RedeliverWebhookDeliveryResponses = {
    200: WebhookRedeliveryEnvelope;
    201: WebhookRedeliveryEnvelope;
};
export type RedeliverWebhookDeliveryResponse = RedeliverWebhookDeliveryResponses[keyof RedeliverWebhookDeliveryResponses];
export type ReceivePaymentOrderWebhookWebhookPayload = WebhookPayload;
export type ReceivePaymentOrderWebhookWebhookRequest = {
    body: ReceivePaymentOrderWebhookWebhookPayload;
    key: 'paymentOrderStateChanged';
    path?: never;
    query?: never;
};
