
import { client } from './client.gen.js';
import type { Client, ClientMeta, Options as Options2, RequestResult, TDataShape } from './client/index.js';
import type { ChangeAdministratorPasswordData, ChangeAdministratorPasswordErrors, ChangeAdministratorPasswordResponses, CreateAdministratorTestPaymentData, CreateAdministratorTestPaymentErrors, CreateAdministratorTestPaymentResponses, CreateManualSettlementData, CreateManualSettlementErrors, CreateManualSettlementResponses, GenerateProviderApplicationKeyData, GenerateProviderApplicationKeyErrors, GenerateProviderApplicationKeyResponses, GetAdministratorOrderByMerchantNumberData, GetAdministratorOrderByMerchantNumberErrors, GetAdministratorOrderByMerchantNumberResponses, GetAdministratorOrderData, GetAdministratorOrderErrors, GetAdministratorOrderResponses, GetAdministratorSessionData, GetAdministratorSessionErrors, GetAdministratorSessionResponses, GetAdministratorSystemAnalyticsData, GetAdministratorSystemAnalyticsErrors, GetAdministratorSystemAnalyticsResponses, GetAdministratorSystemStatusData, GetAdministratorSystemStatusErrors, GetAdministratorSystemStatusResponses, GetFinancialExceptionData, GetFinancialExceptionErrors, GetFinancialExceptionResponses, GetLedgerConflictData, GetLedgerConflictErrors, GetLedgerConflictResponses, GetPaymentMatchData, GetPaymentMatchErrors, GetPaymentMatchResponses, GetReconciliationCandidateData, GetReconciliationCandidateErrors, GetReconciliationCandidateResponses, GetReconciliationLedgerEntryData, GetReconciliationLedgerEntryErrors, GetReconciliationLedgerEntryResponses, GetRuntimeSettingsData, GetRuntimeSettingsErrors, GetRuntimeSettingsResponses, GetWebhookDeliveryData, GetWebhookDeliveryErrors, GetWebhookDeliveryResponses, ListAdministratorOrdersData, ListAdministratorOrdersErrors, ListAdministratorOrdersResponses, ListAdministratorOrderWebhookDeliveriesData, ListAdministratorOrderWebhookDeliveriesErrors, ListAdministratorOrderWebhookDeliveriesResponses, ListAdministratorWorkItemsData, ListAdministratorWorkItemsErrors, ListAdministratorWorkItemsResponses, ListLedgerConflictsData, ListLedgerConflictsErrors, ListLedgerConflictsResponses, ListLedgerEntryCandidatesData, ListLedgerEntryCandidatesErrors, ListLedgerEntryCandidatesResponses, ListOpenFinancialExceptionsData, ListOpenFinancialExceptionsErrors, ListOpenFinancialExceptionsResponses, ListPaymentMatchesData, ListPaymentMatchesErrors, ListPaymentMatchesResponses, ListWebhookDeliveriesData, ListWebhookDeliveriesErrors, ListWebhookDeliveriesResponses, ListWebhookDeliveryAttemptsData, ListWebhookDeliveryAttemptsErrors, ListWebhookDeliveryAttemptsResponses, LoginAdministratorData, LoginAdministratorErrors, LoginAdministratorResponses, LogoutAdministratorSessionData, LogoutAdministratorSessionErrors, LogoutAdministratorSessionResponses, RecordCollectedRefundDebitData, RecordCollectedRefundDebitErrors, RecordCollectedRefundDebitResponses, RedeliverWebhookDeliveryData, RedeliverWebhookDeliveryErrors, RedeliverWebhookDeliveryResponses, ResolveLedgerConflictData, ResolveLedgerConflictErrors, ResolveLedgerConflictResponses, RevealRuntimeSecretData, RevealRuntimeSecretErrors, RevealRuntimeSecretResponses, ReversePaymentSettlementData, ReversePaymentSettlementErrors, ReversePaymentSettlementResponses, RevokeAllAdministratorSessionsData, RevokeAllAdministratorSessionsErrors, RevokeAllAdministratorSessionsResponses, RotateApiClientSecretData, RotateApiClientSecretErrors, RotateApiClientSecretResponses, SetupAdministratorData, SetupAdministratorErrors, SetupAdministratorResponses, UpdateAdvancedSettingsData, UpdateAdvancedSettingsErrors, UpdateAdvancedSettingsResponses, UpdateBackupSettingsData, UpdateBackupSettingsErrors, UpdateBackupSettingsResponses, UpdateCollectionSettingsData, UpdateCollectionSettingsErrors, UpdateCollectionSettingsResponses, UpdateNotificationSettingsData, UpdateNotificationSettingsErrors, UpdateNotificationSettingsResponses, UpdateProviderSettingsData, UpdateProviderSettingsErrors, UpdateProviderSettingsResponses } from './types.gen.js';
export type Options<TData extends TDataShape = TDataShape, ThrowOnError extends boolean = boolean, TResponse = unknown> = Options2<TData, ThrowOnError, TResponse> & {
    client?: Client;
    meta?: keyof ClientMeta extends never ? Record<string, unknown> : ClientMeta;
};
export const setupAdministrator = <ThrowOnError extends boolean = false>(options: Options<SetupAdministratorData, ThrowOnError>): RequestResult<SetupAdministratorResponses, SetupAdministratorErrors, ThrowOnError> => (options.client ?? client).post<SetupAdministratorResponses, SetupAdministratorErrors, ThrowOnError>({
    url: '/api/admin/v1/setup',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const loginAdministrator = <ThrowOnError extends boolean = false>(options: Options<LoginAdministratorData, ThrowOnError>): RequestResult<LoginAdministratorResponses, LoginAdministratorErrors, ThrowOnError> => (options.client ?? client).post<LoginAdministratorResponses, LoginAdministratorErrors, ThrowOnError>({
    url: '/api/admin/v1/session/login',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const getAdministratorSession = <ThrowOnError extends boolean = false>(options?: Options<GetAdministratorSessionData, ThrowOnError>): RequestResult<GetAdministratorSessionResponses, GetAdministratorSessionErrors, ThrowOnError> => (options?.client ?? client).get<GetAdministratorSessionResponses, GetAdministratorSessionErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/session',
    ...options
});
export const getAdministratorSystemStatus = <ThrowOnError extends boolean = false>(options?: Options<GetAdministratorSystemStatusData, ThrowOnError>): RequestResult<GetAdministratorSystemStatusResponses, GetAdministratorSystemStatusErrors, ThrowOnError> => (options?.client ?? client).get<GetAdministratorSystemStatusResponses, GetAdministratorSystemStatusErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/system/status',
    ...options
});
export const getAdministratorSystemAnalytics = <ThrowOnError extends boolean = false>(options?: Options<GetAdministratorSystemAnalyticsData, ThrowOnError>): RequestResult<GetAdministratorSystemAnalyticsResponses, GetAdministratorSystemAnalyticsErrors, ThrowOnError> => (options?.client ?? client).get<GetAdministratorSystemAnalyticsResponses, GetAdministratorSystemAnalyticsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/system/analytics',
    ...options
});
export const listAdministratorWorkItems = <ThrowOnError extends boolean = false>(options?: Options<ListAdministratorWorkItemsData, ThrowOnError>): RequestResult<ListAdministratorWorkItemsResponses, ListAdministratorWorkItemsErrors, ThrowOnError> => (options?.client ?? client).get<ListAdministratorWorkItemsResponses, ListAdministratorWorkItemsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/work-items',
    ...options
});
export const logoutAdministratorSession = <ThrowOnError extends boolean = false>(options: Options<LogoutAdministratorSessionData, ThrowOnError>): RequestResult<LogoutAdministratorSessionResponses, LogoutAdministratorSessionErrors, ThrowOnError> => (options.client ?? client).post<LogoutAdministratorSessionResponses, LogoutAdministratorSessionErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/session/logout',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const revokeAllAdministratorSessions = <ThrowOnError extends boolean = false>(options: Options<RevokeAllAdministratorSessionsData, ThrowOnError>): RequestResult<RevokeAllAdministratorSessionsResponses, RevokeAllAdministratorSessionsErrors, ThrowOnError> => (options.client ?? client).post<RevokeAllAdministratorSessionsResponses, RevokeAllAdministratorSessionsErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/sessions/revoke-all',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const changeAdministratorPassword = <ThrowOnError extends boolean = false>(options: Options<ChangeAdministratorPasswordData, ThrowOnError>): RequestResult<ChangeAdministratorPasswordResponses, ChangeAdministratorPasswordErrors, ThrowOnError> => (options.client ?? client).post<ChangeAdministratorPasswordResponses, ChangeAdministratorPasswordErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/password',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const getRuntimeSettings = <ThrowOnError extends boolean = false>(options?: Options<GetRuntimeSettingsData, ThrowOnError>): RequestResult<GetRuntimeSettingsResponses, GetRuntimeSettingsErrors, ThrowOnError> => (options?.client ?? client).get<GetRuntimeSettingsResponses, GetRuntimeSettingsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/settings',
    ...options
});
export const createAdministratorTestPayment = <ThrowOnError extends boolean = false>(options: Options<CreateAdministratorTestPaymentData, ThrowOnError>): RequestResult<CreateAdministratorTestPaymentResponses, CreateAdministratorTestPaymentErrors, ThrowOnError> => (options.client ?? client).post<CreateAdministratorTestPaymentResponses, CreateAdministratorTestPaymentErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/test-payments',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const updateCollectionSettings = <ThrowOnError extends boolean = false>(options: Options<UpdateCollectionSettingsData, ThrowOnError>): RequestResult<UpdateCollectionSettingsResponses, UpdateCollectionSettingsErrors, ThrowOnError> => (options.client ?? client).put<UpdateCollectionSettingsResponses, UpdateCollectionSettingsErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/settings/collection',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const updateProviderSettings = <ThrowOnError extends boolean = false>(options: Options<UpdateProviderSettingsData, ThrowOnError>): RequestResult<UpdateProviderSettingsResponses, UpdateProviderSettingsErrors, ThrowOnError> => (options.client ?? client).put<UpdateProviderSettingsResponses, UpdateProviderSettingsErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/settings/provider',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const generateProviderApplicationKey = <ThrowOnError extends boolean = false>(options: Options<GenerateProviderApplicationKeyData, ThrowOnError>): RequestResult<GenerateProviderApplicationKeyResponses, GenerateProviderApplicationKeyErrors, ThrowOnError> => (options.client ?? client).post<GenerateProviderApplicationKeyResponses, GenerateProviderApplicationKeyErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/settings/provider/application-key/actions/generate',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const updateNotificationSettings = <ThrowOnError extends boolean = false>(options: Options<UpdateNotificationSettingsData, ThrowOnError>): RequestResult<UpdateNotificationSettingsResponses, UpdateNotificationSettingsErrors, ThrowOnError> => (options.client ?? client).put<UpdateNotificationSettingsResponses, UpdateNotificationSettingsErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/settings/notifications',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const updateAdvancedSettings = <ThrowOnError extends boolean = false>(options: Options<UpdateAdvancedSettingsData, ThrowOnError>): RequestResult<UpdateAdvancedSettingsResponses, UpdateAdvancedSettingsErrors, ThrowOnError> => (options.client ?? client).put<UpdateAdvancedSettingsResponses, UpdateAdvancedSettingsErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/settings/advanced',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const rotateApiClientSecret = <ThrowOnError extends boolean = false>(options: Options<RotateApiClientSecretData, ThrowOnError>): RequestResult<RotateApiClientSecretResponses, RotateApiClientSecretErrors, ThrowOnError> => (options.client ?? client).post<RotateApiClientSecretResponses, RotateApiClientSecretErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/settings/api-key/actions/rotate',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const updateBackupSettings = <ThrowOnError extends boolean = false>(options: Options<UpdateBackupSettingsData, ThrowOnError>): RequestResult<UpdateBackupSettingsResponses, UpdateBackupSettingsErrors, ThrowOnError> => (options.client ?? client).put<UpdateBackupSettingsResponses, UpdateBackupSettingsErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/settings/backup',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const revealRuntimeSecret = <ThrowOnError extends boolean = false>(options: Options<RevealRuntimeSecretData, ThrowOnError>): RequestResult<RevealRuntimeSecretResponses, RevealRuntimeSecretErrors, ThrowOnError> => (options.client ?? client).post<RevealRuntimeSecretResponses, RevealRuntimeSecretErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/settings/secrets/{name}/actions/reveal',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const listAdministratorOrders = <ThrowOnError extends boolean = false>(options?: Options<ListAdministratorOrdersData, ThrowOnError>): RequestResult<ListAdministratorOrdersResponses, ListAdministratorOrdersErrors, ThrowOnError> => (options?.client ?? client).get<ListAdministratorOrdersResponses, ListAdministratorOrdersErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/orders',
    ...options
});
export const getAdministratorOrderByMerchantNumber = <ThrowOnError extends boolean = false>(options: Options<GetAdministratorOrderByMerchantNumberData, ThrowOnError>): RequestResult<GetAdministratorOrderByMerchantNumberResponses, GetAdministratorOrderByMerchantNumberErrors, ThrowOnError> => (options.client ?? client).get<GetAdministratorOrderByMerchantNumberResponses, GetAdministratorOrderByMerchantNumberErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/orders/by-merchant-no/{merchantOrderNo}',
    ...options
});
export const getAdministratorOrder = <ThrowOnError extends boolean = false>(options: Options<GetAdministratorOrderData, ThrowOnError>): RequestResult<GetAdministratorOrderResponses, GetAdministratorOrderErrors, ThrowOnError> => (options.client ?? client).get<GetAdministratorOrderResponses, GetAdministratorOrderErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/orders/{orderId}',
    ...options
});
export const listAdministratorOrderWebhookDeliveries = <ThrowOnError extends boolean = false>(options: Options<ListAdministratorOrderWebhookDeliveriesData, ThrowOnError>): RequestResult<ListAdministratorOrderWebhookDeliveriesResponses, ListAdministratorOrderWebhookDeliveriesErrors, ThrowOnError> => (options.client ?? client).get<ListAdministratorOrderWebhookDeliveriesResponses, ListAdministratorOrderWebhookDeliveriesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/orders/{orderId}/notifications/deliveries',
    ...options
});
export const listLedgerConflicts = <ThrowOnError extends boolean = false>(options?: Options<ListLedgerConflictsData, ThrowOnError>): RequestResult<ListLedgerConflictsResponses, ListLedgerConflictsErrors, ThrowOnError> => (options?.client ?? client).get<ListLedgerConflictsResponses, ListLedgerConflictsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/ledger/conflicts',
    ...options
});
export const getLedgerConflict = <ThrowOnError extends boolean = false>(options: Options<GetLedgerConflictData, ThrowOnError>): RequestResult<GetLedgerConflictResponses, GetLedgerConflictErrors, ThrowOnError> => (options.client ?? client).get<GetLedgerConflictResponses, GetLedgerConflictErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/ledger/conflicts/{conflictId}',
    ...options
});
export const resolveLedgerConflict = <ThrowOnError extends boolean = false>(options: Options<ResolveLedgerConflictData, ThrowOnError>): RequestResult<ResolveLedgerConflictResponses, ResolveLedgerConflictErrors, ThrowOnError> => (options.client ?? client).post<ResolveLedgerConflictResponses, ResolveLedgerConflictErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/ledger/conflicts/{conflictId}/actions/resolve',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const getReconciliationCandidate = <ThrowOnError extends boolean = false>(options: Options<GetReconciliationCandidateData, ThrowOnError>): RequestResult<GetReconciliationCandidateResponses, GetReconciliationCandidateErrors, ThrowOnError> => (options.client ?? client).get<GetReconciliationCandidateResponses, GetReconciliationCandidateErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/candidates/{candidateId}',
    ...options
});
export const getReconciliationLedgerEntry = <ThrowOnError extends boolean = false>(options: Options<GetReconciliationLedgerEntryData, ThrowOnError>): RequestResult<GetReconciliationLedgerEntryResponses, GetReconciliationLedgerEntryErrors, ThrowOnError> => (options.client ?? client).get<GetReconciliationLedgerEntryResponses, GetReconciliationLedgerEntryErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/ledger-entries/{ledgerEntryId}',
    ...options
});
export const listLedgerEntryCandidates = <ThrowOnError extends boolean = false>(options: Options<ListLedgerEntryCandidatesData, ThrowOnError>): RequestResult<ListLedgerEntryCandidatesResponses, ListLedgerEntryCandidatesErrors, ThrowOnError> => (options.client ?? client).get<ListLedgerEntryCandidatesResponses, ListLedgerEntryCandidatesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/ledger-entries/{ledgerEntryId}/candidates',
    ...options
});
export const listPaymentMatches = <ThrowOnError extends boolean = false>(options?: Options<ListPaymentMatchesData, ThrowOnError>): RequestResult<ListPaymentMatchesResponses, ListPaymentMatchesErrors, ThrowOnError> => (options?.client ?? client).get<ListPaymentMatchesResponses, ListPaymentMatchesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/matches',
    ...options
});
export const getPaymentMatch = <ThrowOnError extends boolean = false>(options: Options<GetPaymentMatchData, ThrowOnError>): RequestResult<GetPaymentMatchResponses, GetPaymentMatchErrors, ThrowOnError> => (options.client ?? client).get<GetPaymentMatchResponses, GetPaymentMatchErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/matches/{paymentMatchId}',
    ...options
});
export const listOpenFinancialExceptions = <ThrowOnError extends boolean = false>(options?: Options<ListOpenFinancialExceptionsData, ThrowOnError>): RequestResult<ListOpenFinancialExceptionsResponses, ListOpenFinancialExceptionsErrors, ThrowOnError> => (options?.client ?? client).get<ListOpenFinancialExceptionsResponses, ListOpenFinancialExceptionsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/exceptions',
    ...options
});
export const getFinancialException = <ThrowOnError extends boolean = false>(options: Options<GetFinancialExceptionData, ThrowOnError>): RequestResult<GetFinancialExceptionResponses, GetFinancialExceptionErrors, ThrowOnError> => (options.client ?? client).get<GetFinancialExceptionResponses, GetFinancialExceptionErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/exceptions/{exceptionId}',
    ...options
});
export const reversePaymentSettlement = <ThrowOnError extends boolean = false>(options: Options<ReversePaymentSettlementData, ThrowOnError>): RequestResult<ReversePaymentSettlementResponses, ReversePaymentSettlementErrors, ThrowOnError> => (options.client ?? client).post<ReversePaymentSettlementResponses, ReversePaymentSettlementErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/reconciliation/matches/{paymentMatchId}/actions/reverse',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const createManualSettlement = <ThrowOnError extends boolean = false>(options: Options<CreateManualSettlementData, ThrowOnError>): RequestResult<CreateManualSettlementResponses, CreateManualSettlementErrors, ThrowOnError> => (options.client ?? client).post<CreateManualSettlementResponses, CreateManualSettlementErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/reconciliation/settlements/manual',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const recordCollectedRefundDebit = <ThrowOnError extends boolean = false>(options: Options<RecordCollectedRefundDebitData, ThrowOnError>): RequestResult<RecordCollectedRefundDebitResponses, RecordCollectedRefundDebitErrors, ThrowOnError> => (options.client ?? client).post<RecordCollectedRefundDebitResponses, RecordCollectedRefundDebitErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/reconciliation/refunds',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const listWebhookDeliveries = <ThrowOnError extends boolean = false>(options?: Options<ListWebhookDeliveriesData, ThrowOnError>): RequestResult<ListWebhookDeliveriesResponses, ListWebhookDeliveriesErrors, ThrowOnError> => (options?.client ?? client).get<ListWebhookDeliveriesResponses, ListWebhookDeliveriesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/webhooks/deliveries',
    ...options
});
export const getWebhookDelivery = <ThrowOnError extends boolean = false>(options: Options<GetWebhookDeliveryData, ThrowOnError>): RequestResult<GetWebhookDeliveryResponses, GetWebhookDeliveryErrors, ThrowOnError> => (options.client ?? client).get<GetWebhookDeliveryResponses, GetWebhookDeliveryErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/webhooks/deliveries/{deliveryId}',
    ...options
});
export const listWebhookDeliveryAttempts = <ThrowOnError extends boolean = false>(options: Options<ListWebhookDeliveryAttemptsData, ThrowOnError>): RequestResult<ListWebhookDeliveryAttemptsResponses, ListWebhookDeliveryAttemptsErrors, ThrowOnError> => (options.client ?? client).get<ListWebhookDeliveryAttemptsResponses, ListWebhookDeliveryAttemptsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/webhooks/deliveries/{deliveryId}/attempts',
    ...options
});
export const redeliverWebhookDelivery = <ThrowOnError extends boolean = false>(options: Options<RedeliverWebhookDeliveryData, ThrowOnError>): RequestResult<RedeliverWebhookDeliveryResponses, RedeliverWebhookDeliveryErrors, ThrowOnError> => (options.client ?? client).post<RedeliverWebhookDeliveryResponses, RedeliverWebhookDeliveryErrors, ThrowOnError>({
    security: [
        {
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        },
        {
            in: 'cookie',
            name: '__Host-perpay_csrf',
            type: 'apiKey'
        },
        { name: 'X-CSRF-Token', type: 'apiKey' }
    ],
    url: '/api/admin/v1/webhooks/deliveries/{deliveryId}/actions/redeliver',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
