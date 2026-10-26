
import { client } from './client.gen.js';
import type { Client, ClientMeta, Options as Options2, RequestResult, TDataShape } from './client/index.js';
import type { ActivateProviderApplicationKeyData, ActivateProviderApplicationKeyErrors, ActivateProviderApplicationKeyResponses, ChangeAdministratorPasswordData, ChangeAdministratorPasswordErrors, ChangeAdministratorPasswordResponses, CheckOfficialUpdateData, CheckOfficialUpdateErrors, CheckOfficialUpdateResponses, CreateAdministratorTestPaymentData, CreateAdministratorTestPaymentErrors, CreateAdministratorTestPaymentResponses, CreateManualSettlementData, CreateManualSettlementErrors, CreateManualSettlementResponses, CreateSiteData, CreateSiteErrors, CreateSiteResponses, DeleteSiteData, DeleteSiteErrors, DeleteSiteResponses, DiscardProviderApplicationKeyData, DiscardProviderApplicationKeyErrors, DiscardProviderApplicationKeyResponses, ExportAdministratorOrdersData, ExportAdministratorOrdersErrors, ExportAdministratorOrdersResponses, GenerateProviderApplicationKeyData, GenerateProviderApplicationKeyErrors, GenerateProviderApplicationKeyResponses, GetAdminAccessSettingsData, GetAdminAccessSettingsErrors, GetAdminAccessSettingsResponses, GetAdministratorLedgerEntryData, GetAdministratorLedgerEntryErrors, GetAdministratorLedgerEntryResponses, GetAdministratorOrderByMerchantNumberData, GetAdministratorOrderByMerchantNumberErrors, GetAdministratorOrderByMerchantNumberResponses, GetAdministratorOrderData, GetAdministratorOrderErrors, GetAdministratorOrderResponses, GetAdministratorSessionData, GetAdministratorSessionErrors, GetAdministratorSessionResponses, GetAdministratorSystemAnalyticsData, GetAdministratorSystemAnalyticsErrors, GetAdministratorSystemAnalyticsResponses, GetAdministratorSystemStatusData, GetAdministratorSystemStatusErrors, GetAdministratorSystemStatusResponses, GetAdministratorWorkItemSummaryData, GetAdministratorWorkItemSummaryErrors, GetAdministratorWorkItemSummaryResponses, GetCollectionPolicyData, GetCollectionPolicyErrors, GetCollectionPolicyResponses, GetFinancialExceptionData, GetFinancialExceptionErrors, GetFinancialExceptionResponses, GetLedgerConflictData, GetLedgerConflictErrors, GetLedgerConflictResponses, GetPaymentMatchData, GetPaymentMatchErrors, GetPaymentMatchResponses, GetReconciliationCandidateData, GetReconciliationCandidateErrors, GetReconciliationCandidateResponses, GetReconciliationLedgerEntryData, GetReconciliationLedgerEntryErrors, GetReconciliationLedgerEntryResponses, GetRuntimeSettingsData, GetRuntimeSettingsErrors, GetRuntimeSettingsResponses, GetSiteData, GetSiteDefaultsData, GetSiteDefaultsErrors, GetSiteDefaultsResponses, GetSiteErrors, GetSiteResponses, GetWebhookDeliveryData, GetWebhookDeliveryErrors, GetWebhookDeliveryResponses, IgnoreAllAdministratorWorkItemsData, IgnoreAllAdministratorWorkItemsErrors, IgnoreAllAdministratorWorkItemsResponses, ListAdministratorLedgerEntriesData, ListAdministratorLedgerEntriesErrors, ListAdministratorLedgerEntriesResponses, ListAdministratorOrdersData, ListAdministratorOrdersErrors, ListAdministratorOrdersResponses, ListAdministratorOrderWebhookDeliveriesData, ListAdministratorOrderWebhookDeliveriesErrors, ListAdministratorOrderWebhookDeliveriesResponses, ListAdministratorSessionsData, ListAdministratorSessionsErrors, ListAdministratorSessionsResponses, ListAdministratorWorkItemsData, ListAdministratorWorkItemsErrors, ListAdministratorWorkItemsResponses, ListLedgerConflictsData, ListLedgerConflictsErrors, ListLedgerConflictsResponses, ListLedgerEntryCandidatesData, ListLedgerEntryCandidatesErrors, ListLedgerEntryCandidatesResponses, ListManualSettlementLedgerEntriesData, ListManualSettlementLedgerEntriesErrors, ListManualSettlementLedgerEntriesResponses, ListManualSettlementOrdersData, ListManualSettlementOrdersErrors, ListManualSettlementOrdersResponses, ListOpenFinancialExceptionsData, ListOpenFinancialExceptionsErrors, ListOpenFinancialExceptionsResponses, ListPaymentMatchesData, ListPaymentMatchesErrors, ListPaymentMatchesResponses, ListSiteOverviewData, ListSiteOverviewErrors, ListSiteOverviewResponses, ListSitesData, ListSitesErrors, ListSitesResponses, ListWebhookDeliveriesData, ListWebhookDeliveriesErrors, ListWebhookDeliveriesResponses, ListWebhookDeliveryAttemptsData, ListWebhookDeliveryAttemptsErrors, ListWebhookDeliveryAttemptsResponses, LoginAdministratorData, LoginAdministratorErrors, LoginAdministratorResponses, LogoutAdministratorSessionData, LogoutAdministratorSessionErrors, LogoutAdministratorSessionResponses, OpenAdministratorOrderCheckoutData, OpenAdministratorOrderCheckoutErrors, RecordCollectedRefundDebitData, RecordCollectedRefundDebitErrors, RedeliverWebhookDeliveryData, RedeliverWebhookDeliveryErrors, RedeliverWebhookDeliveryResponses, RegenerateProviderApplicationKeyData, RegenerateProviderApplicationKeyErrors, RegenerateProviderApplicationKeyResponses, ResolveLedgerConflictData, ResolveLedgerConflictErrors, ResolveLedgerConflictResponses, RestoreAdministratorWorkItemData, RestoreAdministratorWorkItemErrors, RestoreAdministratorWorkItemResponses, RevealRuntimeSecretData, RevealRuntimeSecretErrors, RevealRuntimeSecretResponses, ReversePaymentSettlementData, ReversePaymentSettlementErrors, ReversePaymentSettlementResponses, RevokeAdministratorSessionData, RevokeAdministratorSessionErrors, RevokeAdministratorSessionResponses, RevokeAllAdministratorSessionsData, RevokeAllAdministratorSessionsErrors, RevokeAllAdministratorSessionsResponses, RevokeOtherAdministratorSessionsData, RevokeOtherAdministratorSessionsErrors, RevokeOtherAdministratorSessionsResponses, RotateApiClientSecretData, RotateApiClientSecretErrors, RotateApiClientSecretResponses, RotateSiteApiSecretData, RotateSiteApiSecretErrors, RotateSiteApiSecretResponses, RotateSiteWebhookSecretData, RotateSiteWebhookSecretErrors, RotateSiteWebhookSecretResponses, RotateWebhookSigningSecretData, RotateWebhookSigningSecretErrors, RotateWebhookSigningSecretResponses, SetAdministratorRefundMarkData, SetAdministratorRefundMarkErrors, SetAdministratorRefundMarkResponses, SetupAdministratorData, SetupAdministratorErrors, SetupAdministratorResponses, SiteCreateAdministratorTestPaymentData, SiteCreateAdministratorTestPaymentErrors, SiteCreateAdministratorTestPaymentResponses, SiteCreateManualSettlementData, SiteCreateManualSettlementErrors, SiteCreateManualSettlementResponses, SiteExportAdministratorOrdersData, SiteExportAdministratorOrdersErrors, SiteExportAdministratorOrdersResponses, SiteGetAdministratorOrderByMerchantNumberData, SiteGetAdministratorOrderByMerchantNumberErrors, SiteGetAdministratorOrderByMerchantNumberResponses, SiteGetAdministratorOrderData, SiteGetAdministratorOrderErrors, SiteGetAdministratorOrderResponses, SiteGetAdministratorSystemAnalyticsData, SiteGetAdministratorSystemAnalyticsErrors, SiteGetAdministratorSystemAnalyticsResponses, SiteGetAdministratorWorkItemSummaryData, SiteGetAdministratorWorkItemSummaryErrors, SiteGetAdministratorWorkItemSummaryResponses, SiteGetFinancialExceptionData, SiteGetFinancialExceptionErrors, SiteGetFinancialExceptionResponses, SiteGetPaymentMatchData, SiteGetPaymentMatchErrors, SiteGetPaymentMatchResponses, SiteGetReconciliationCandidateData, SiteGetReconciliationCandidateErrors, SiteGetReconciliationCandidateResponses, SiteGetReconciliationLedgerEntryData, SiteGetReconciliationLedgerEntryErrors, SiteGetReconciliationLedgerEntryResponses, SiteGetWebhookDeliveryData, SiteGetWebhookDeliveryErrors, SiteGetWebhookDeliveryResponses, SiteIgnoreAllAdministratorWorkItemsData, SiteIgnoreAllAdministratorWorkItemsErrors, SiteIgnoreAllAdministratorWorkItemsResponses, SiteListAdministratorOrdersData, SiteListAdministratorOrdersErrors, SiteListAdministratorOrdersResponses, SiteListAdministratorOrderWebhookDeliveriesData, SiteListAdministratorOrderWebhookDeliveriesErrors, SiteListAdministratorOrderWebhookDeliveriesResponses, SiteListAdministratorWorkItemsData, SiteListAdministratorWorkItemsErrors, SiteListAdministratorWorkItemsResponses, SiteListLedgerEntryCandidatesData, SiteListLedgerEntryCandidatesErrors, SiteListLedgerEntryCandidatesResponses, SiteListManualSettlementLedgerEntriesData, SiteListManualSettlementLedgerEntriesErrors, SiteListManualSettlementLedgerEntriesResponses, SiteListWebhookDeliveriesData, SiteListWebhookDeliveriesErrors, SiteListWebhookDeliveriesResponses, SiteListWebhookDeliveryAttemptsData, SiteListWebhookDeliveryAttemptsErrors, SiteListWebhookDeliveryAttemptsResponses, SiteOpenAdministratorOrderCheckoutData, SiteOpenAdministratorOrderCheckoutErrors, SiteRedeliverWebhookDeliveryData, SiteRedeliverWebhookDeliveryErrors, SiteRedeliverWebhookDeliveryResponses, SiteRestoreAdministratorWorkItemData, SiteRestoreAdministratorWorkItemErrors, SiteRestoreAdministratorWorkItemResponses, SiteReversePaymentSettlementData, SiteReversePaymentSettlementErrors, SiteReversePaymentSettlementResponses, SiteSetAdministratorRefundMarkData, SiteSetAdministratorRefundMarkErrors, SiteSetAdministratorRefundMarkResponses, UpdateAdminAccessSettingsData, UpdateAdminAccessSettingsErrors, UpdateAdminAccessSettingsResponses, UpdateAdvancedSettingsData, UpdateAdvancedSettingsErrors, UpdateAdvancedSettingsResponses, UpdateBackupSettingsData, UpdateBackupSettingsErrors, UpdateBackupSettingsResponses, UpdateCollectionPolicyData, UpdateCollectionPolicyErrors, UpdateCollectionPolicyResponses, UpdateCollectionSettingsData, UpdateCollectionSettingsErrors, UpdateCollectionSettingsResponses, UpdateDisplaySettingsData, UpdateDisplaySettingsErrors, UpdateDisplaySettingsResponses, UpdateNotificationSettingsData, UpdateNotificationSettingsErrors, UpdateNotificationSettingsResponses, UpdateProviderSettingsData, UpdateProviderSettingsErrors, UpdateProviderSettingsResponses, UpdateSiteData, UpdateSiteDefaultsData, UpdateSiteDefaultsErrors, UpdateSiteDefaultsResponses, UpdateSiteErrors, UpdateSiteResponses, ViewSiteApiSecretData, ViewSiteApiSecretErrors, ViewSiteApiSecretResponses, ViewSiteWebhookSecretData, ViewSiteWebhookSecretErrors, ViewSiteWebhookSecretResponses } from './types.gen.js';
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
export const listAdministratorSessions = <ThrowOnError extends boolean = false>(options?: Options<ListAdministratorSessionsData, ThrowOnError>): RequestResult<ListAdministratorSessionsResponses, ListAdministratorSessionsErrors, ThrowOnError> => (options?.client ?? client).get<ListAdministratorSessionsResponses, ListAdministratorSessionsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sessions',
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
export const checkOfficialUpdate = <ThrowOnError extends boolean = false>(options?: Options<CheckOfficialUpdateData, ThrowOnError>): RequestResult<CheckOfficialUpdateResponses, CheckOfficialUpdateErrors, ThrowOnError> => (options?.client ?? client).get<CheckOfficialUpdateResponses, CheckOfficialUpdateErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/system/update',
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
export const getAdministratorWorkItemSummary = <ThrowOnError extends boolean = false>(options?: Options<GetAdministratorWorkItemSummaryData, ThrowOnError>): RequestResult<GetAdministratorWorkItemSummaryResponses, GetAdministratorWorkItemSummaryErrors, ThrowOnError> => (options?.client ?? client).get<GetAdministratorWorkItemSummaryResponses, GetAdministratorWorkItemSummaryErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/work-items/summary',
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
export const ignoreAllAdministratorWorkItems = <ThrowOnError extends boolean = false>(options: Options<IgnoreAllAdministratorWorkItemsData, ThrowOnError>): RequestResult<IgnoreAllAdministratorWorkItemsResponses, IgnoreAllAdministratorWorkItemsErrors, ThrowOnError> => (options.client ?? client).post<IgnoreAllAdministratorWorkItemsResponses, IgnoreAllAdministratorWorkItemsErrors, ThrowOnError>({
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
    url: '/api/admin/v1/work-items/actions/ignore-all',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const restoreAdministratorWorkItem = <ThrowOnError extends boolean = false>(options: Options<RestoreAdministratorWorkItemData, ThrowOnError>): RequestResult<RestoreAdministratorWorkItemResponses, RestoreAdministratorWorkItemErrors, ThrowOnError> => (options.client ?? client).post<RestoreAdministratorWorkItemResponses, RestoreAdministratorWorkItemErrors, ThrowOnError>({
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
    url: '/api/admin/v1/work-items/{type}/{resourceId}/actions/restore',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const setAdministratorRefundMark = <ThrowOnError extends boolean = false>(options: Options<SetAdministratorRefundMarkData, ThrowOnError>): RequestResult<SetAdministratorRefundMarkResponses, SetAdministratorRefundMarkErrors, ThrowOnError> => (options.client ?? client).put<SetAdministratorRefundMarkResponses, SetAdministratorRefundMarkErrors, ThrowOnError>({
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
    url: '/api/admin/v1/orders/{orderId}/refund-mark',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
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
export const revokeAdministratorSession = <ThrowOnError extends boolean = false>(options: Options<RevokeAdministratorSessionData, ThrowOnError>): RequestResult<RevokeAdministratorSessionResponses, RevokeAdministratorSessionErrors, ThrowOnError> => (options.client ?? client).post<RevokeAdministratorSessionResponses, RevokeAdministratorSessionErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sessions/{session_id}/revoke',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const revokeOtherAdministratorSessions = <ThrowOnError extends boolean = false>(options: Options<RevokeOtherAdministratorSessionsData, ThrowOnError>): RequestResult<RevokeOtherAdministratorSessionsResponses, RevokeOtherAdministratorSessionsErrors, ThrowOnError> => (options.client ?? client).post<RevokeOtherAdministratorSessionsResponses, RevokeOtherAdministratorSessionsErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sessions/revoke-others',
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
export const regenerateProviderApplicationKey = <ThrowOnError extends boolean = false>(options: Options<RegenerateProviderApplicationKeyData, ThrowOnError>): RequestResult<RegenerateProviderApplicationKeyResponses, RegenerateProviderApplicationKeyErrors, ThrowOnError> => (options.client ?? client).post<RegenerateProviderApplicationKeyResponses, RegenerateProviderApplicationKeyErrors, ThrowOnError>({
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
    url: '/api/admin/v1/settings/provider/application-key/actions/regenerate',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const activateProviderApplicationKey = <ThrowOnError extends boolean = false>(options: Options<ActivateProviderApplicationKeyData, ThrowOnError>): RequestResult<ActivateProviderApplicationKeyResponses, ActivateProviderApplicationKeyErrors, ThrowOnError> => (options.client ?? client).post<ActivateProviderApplicationKeyResponses, ActivateProviderApplicationKeyErrors, ThrowOnError>({
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
    url: '/api/admin/v1/settings/provider/application-key/actions/activate',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const discardProviderApplicationKey = <ThrowOnError extends boolean = false>(options: Options<DiscardProviderApplicationKeyData, ThrowOnError>): RequestResult<DiscardProviderApplicationKeyResponses, DiscardProviderApplicationKeyErrors, ThrowOnError> => (options.client ?? client).post<DiscardProviderApplicationKeyResponses, DiscardProviderApplicationKeyErrors, ThrowOnError>({
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
    url: '/api/admin/v1/settings/provider/application-key/actions/discard',
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
export const rotateWebhookSigningSecret = <ThrowOnError extends boolean = false>(options: Options<RotateWebhookSigningSecretData, ThrowOnError>): RequestResult<RotateWebhookSigningSecretResponses, RotateWebhookSigningSecretErrors, ThrowOnError> => (options.client ?? client).post<RotateWebhookSigningSecretResponses, RotateWebhookSigningSecretErrors, ThrowOnError>({
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
    url: '/api/admin/v1/settings/notification-key/actions/rotate',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const getAdminAccessSettings = <ThrowOnError extends boolean = false>(options?: Options<GetAdminAccessSettingsData, ThrowOnError>): RequestResult<GetAdminAccessSettingsResponses, GetAdminAccessSettingsErrors, ThrowOnError> => (options?.client ?? client).get<GetAdminAccessSettingsResponses, GetAdminAccessSettingsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/settings/admin-access',
    ...options
});
export const updateAdminAccessSettings = <ThrowOnError extends boolean = false>(options: Options<UpdateAdminAccessSettingsData, ThrowOnError>): RequestResult<UpdateAdminAccessSettingsResponses, UpdateAdminAccessSettingsErrors, ThrowOnError> => (options.client ?? client).put<UpdateAdminAccessSettingsResponses, UpdateAdminAccessSettingsErrors, ThrowOnError>({
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
    url: '/api/admin/v1/settings/admin-access',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const updateDisplaySettings = <ThrowOnError extends boolean = false>(options: Options<UpdateDisplaySettingsData, ThrowOnError>): RequestResult<UpdateDisplaySettingsResponses, UpdateDisplaySettingsErrors, ThrowOnError> => (options.client ?? client).put<UpdateDisplaySettingsResponses, UpdateDisplaySettingsErrors, ThrowOnError>({
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
    url: '/api/admin/v1/settings/display',
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
export const exportAdministratorOrders = <ThrowOnError extends boolean = false>(options: Options<ExportAdministratorOrdersData, ThrowOnError>): RequestResult<ExportAdministratorOrdersResponses, ExportAdministratorOrdersErrors, ThrowOnError> => (options.client ?? client).post<ExportAdministratorOrdersResponses, ExportAdministratorOrdersErrors, ThrowOnError>({
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
    url: '/api/admin/v1/orders/export',
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
export const openAdministratorOrderCheckout = <ThrowOnError extends boolean = false>(options: Options<OpenAdministratorOrderCheckoutData, ThrowOnError>): RequestResult<unknown, OpenAdministratorOrderCheckoutErrors, ThrowOnError> => (options.client ?? client).get<unknown, OpenAdministratorOrderCheckoutErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/orders/{orderId}/checkout',
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
export const listAdministratorLedgerEntries = <ThrowOnError extends boolean = false>(options?: Options<ListAdministratorLedgerEntriesData, ThrowOnError>): RequestResult<ListAdministratorLedgerEntriesResponses, ListAdministratorLedgerEntriesErrors, ThrowOnError> => (options?.client ?? client).get<ListAdministratorLedgerEntriesResponses, ListAdministratorLedgerEntriesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/ledger/entries',
    ...options
});
export const getAdministratorLedgerEntry = <ThrowOnError extends boolean = false>(options: Options<GetAdministratorLedgerEntryData, ThrowOnError>): RequestResult<GetAdministratorLedgerEntryResponses, GetAdministratorLedgerEntryErrors, ThrowOnError> => (options.client ?? client).get<GetAdministratorLedgerEntryResponses, GetAdministratorLedgerEntryErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/ledger/entries/{ledgerEntryId}',
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
export const listManualSettlementOrders = <ThrowOnError extends boolean = false>(options?: Options<ListManualSettlementOrdersData, ThrowOnError>): RequestResult<ListManualSettlementOrdersResponses, ListManualSettlementOrdersErrors, ThrowOnError> => (options?.client ?? client).get<ListManualSettlementOrdersResponses, ListManualSettlementOrdersErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/settlements/manual/orders',
    ...options
});
export const listManualSettlementLedgerEntries = <ThrowOnError extends boolean = false>(options: Options<ListManualSettlementLedgerEntriesData, ThrowOnError>): RequestResult<ListManualSettlementLedgerEntriesResponses, ListManualSettlementLedgerEntriesErrors, ThrowOnError> => (options.client ?? client).get<ListManualSettlementLedgerEntriesResponses, ListManualSettlementLedgerEntriesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/reconciliation/settlements/manual/ledger-entries',
    ...options
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
export const recordCollectedRefundDebit = <ThrowOnError extends boolean = false>(options: Options<RecordCollectedRefundDebitData, ThrowOnError>): RequestResult<unknown, RecordCollectedRefundDebitErrors, ThrowOnError> => (options.client ?? client).post<unknown, RecordCollectedRefundDebitErrors, ThrowOnError>({
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
export const listSites = <ThrowOnError extends boolean = false>(options?: Options<ListSitesData, ThrowOnError>): RequestResult<ListSitesResponses, ListSitesErrors, ThrowOnError> => (options?.client ?? client).get<ListSitesResponses, ListSitesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites',
    ...options
});
export const createSite = <ThrowOnError extends boolean = false>(options: Options<CreateSiteData, ThrowOnError>): RequestResult<CreateSiteResponses, CreateSiteErrors, ThrowOnError> => (options.client ?? client).post<CreateSiteResponses, CreateSiteErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const deleteSite = <ThrowOnError extends boolean = false>(options: Options<DeleteSiteData, ThrowOnError>): RequestResult<DeleteSiteResponses, DeleteSiteErrors, ThrowOnError> => (options.client ?? client).delete<DeleteSiteResponses, DeleteSiteErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const getSite = <ThrowOnError extends boolean = false>(options: Options<GetSiteData, ThrowOnError>): RequestResult<GetSiteResponses, GetSiteErrors, ThrowOnError> => (options.client ?? client).get<GetSiteResponses, GetSiteErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}',
    ...options
});
export const updateSite = <ThrowOnError extends boolean = false>(options: Options<UpdateSiteData, ThrowOnError>): RequestResult<UpdateSiteResponses, UpdateSiteErrors, ThrowOnError> => (options.client ?? client).put<UpdateSiteResponses, UpdateSiteErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const getSiteDefaults = <ThrowOnError extends boolean = false>(options?: Options<GetSiteDefaultsData, ThrowOnError>): RequestResult<GetSiteDefaultsResponses, GetSiteDefaultsErrors, ThrowOnError> => (options?.client ?? client).get<GetSiteDefaultsResponses, GetSiteDefaultsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/settings/site-defaults',
    ...options
});
export const updateSiteDefaults = <ThrowOnError extends boolean = false>(options: Options<UpdateSiteDefaultsData, ThrowOnError>): RequestResult<UpdateSiteDefaultsResponses, UpdateSiteDefaultsErrors, ThrowOnError> => (options.client ?? client).put<UpdateSiteDefaultsResponses, UpdateSiteDefaultsErrors, ThrowOnError>({
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
    url: '/api/admin/v1/settings/site-defaults',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const rotateSiteApiSecret = <ThrowOnError extends boolean = false>(options: Options<RotateSiteApiSecretData, ThrowOnError>): RequestResult<RotateSiteApiSecretResponses, RotateSiteApiSecretErrors, ThrowOnError> => (options.client ?? client).post<RotateSiteApiSecretResponses, RotateSiteApiSecretErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/secrets/api_secret/actions/rotate',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const viewSiteApiSecret = <ThrowOnError extends boolean = false>(options: Options<ViewSiteApiSecretData, ThrowOnError>): RequestResult<ViewSiteApiSecretResponses, ViewSiteApiSecretErrors, ThrowOnError> => (options.client ?? client).post<ViewSiteApiSecretResponses, ViewSiteApiSecretErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/secrets/api_secret/actions/view',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const rotateSiteWebhookSecret = <ThrowOnError extends boolean = false>(options: Options<RotateSiteWebhookSecretData, ThrowOnError>): RequestResult<RotateSiteWebhookSecretResponses, RotateSiteWebhookSecretErrors, ThrowOnError> => (options.client ?? client).post<RotateSiteWebhookSecretResponses, RotateSiteWebhookSecretErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/secrets/webhook_secret/actions/rotate',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const viewSiteWebhookSecret = <ThrowOnError extends boolean = false>(options: Options<ViewSiteWebhookSecretData, ThrowOnError>): RequestResult<ViewSiteWebhookSecretResponses, ViewSiteWebhookSecretErrors, ThrowOnError> => (options.client ?? client).post<ViewSiteWebhookSecretResponses, ViewSiteWebhookSecretErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/secrets/webhook_secret/actions/view',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const getCollectionPolicy = <ThrowOnError extends boolean = false>(options?: Options<GetCollectionPolicyData, ThrowOnError>): RequestResult<GetCollectionPolicyResponses, GetCollectionPolicyErrors, ThrowOnError> => (options?.client ?? client).get<GetCollectionPolicyResponses, GetCollectionPolicyErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/settings/collection-policy',
    ...options
});
export const updateCollectionPolicy = <ThrowOnError extends boolean = false>(options: Options<UpdateCollectionPolicyData, ThrowOnError>): RequestResult<UpdateCollectionPolicyResponses, UpdateCollectionPolicyErrors, ThrowOnError> => (options.client ?? client).put<UpdateCollectionPolicyResponses, UpdateCollectionPolicyErrors, ThrowOnError>({
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
    url: '/api/admin/v1/settings/collection-policy',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const siteGetAdministratorSystemAnalytics = <ThrowOnError extends boolean = false>(options: Options<SiteGetAdministratorSystemAnalyticsData, ThrowOnError>): RequestResult<SiteGetAdministratorSystemAnalyticsResponses, SiteGetAdministratorSystemAnalyticsErrors, ThrowOnError> => (options.client ?? client).get<SiteGetAdministratorSystemAnalyticsResponses, SiteGetAdministratorSystemAnalyticsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/system/analytics',
    ...options
});
export const siteListAdministratorWorkItems = <ThrowOnError extends boolean = false>(options: Options<SiteListAdministratorWorkItemsData, ThrowOnError>): RequestResult<SiteListAdministratorWorkItemsResponses, SiteListAdministratorWorkItemsErrors, ThrowOnError> => (options.client ?? client).get<SiteListAdministratorWorkItemsResponses, SiteListAdministratorWorkItemsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/work-items',
    ...options
});
export const siteGetAdministratorWorkItemSummary = <ThrowOnError extends boolean = false>(options: Options<SiteGetAdministratorWorkItemSummaryData, ThrowOnError>): RequestResult<SiteGetAdministratorWorkItemSummaryResponses, SiteGetAdministratorWorkItemSummaryErrors, ThrowOnError> => (options.client ?? client).get<SiteGetAdministratorWorkItemSummaryResponses, SiteGetAdministratorWorkItemSummaryErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/work-items/summary',
    ...options
});
export const siteIgnoreAllAdministratorWorkItems = <ThrowOnError extends boolean = false>(options: Options<SiteIgnoreAllAdministratorWorkItemsData, ThrowOnError>): RequestResult<SiteIgnoreAllAdministratorWorkItemsResponses, SiteIgnoreAllAdministratorWorkItemsErrors, ThrowOnError> => (options.client ?? client).post<SiteIgnoreAllAdministratorWorkItemsResponses, SiteIgnoreAllAdministratorWorkItemsErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/work-items/actions/ignore-all',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const siteRestoreAdministratorWorkItem = <ThrowOnError extends boolean = false>(options: Options<SiteRestoreAdministratorWorkItemData, ThrowOnError>): RequestResult<SiteRestoreAdministratorWorkItemResponses, SiteRestoreAdministratorWorkItemErrors, ThrowOnError> => (options.client ?? client).post<SiteRestoreAdministratorWorkItemResponses, SiteRestoreAdministratorWorkItemErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/work-items/{type}/{resourceId}/actions/restore',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const siteListAdministratorOrders = <ThrowOnError extends boolean = false>(options: Options<SiteListAdministratorOrdersData, ThrowOnError>): RequestResult<SiteListAdministratorOrdersResponses, SiteListAdministratorOrdersErrors, ThrowOnError> => (options.client ?? client).get<SiteListAdministratorOrdersResponses, SiteListAdministratorOrdersErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/orders',
    ...options
});
export const siteExportAdministratorOrders = <ThrowOnError extends boolean = false>(options: Options<SiteExportAdministratorOrdersData, ThrowOnError>): RequestResult<SiteExportAdministratorOrdersResponses, SiteExportAdministratorOrdersErrors, ThrowOnError> => (options.client ?? client).post<SiteExportAdministratorOrdersResponses, SiteExportAdministratorOrdersErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/orders/export',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const siteCreateAdministratorTestPayment = <ThrowOnError extends boolean = false>(options: Options<SiteCreateAdministratorTestPaymentData, ThrowOnError>): RequestResult<SiteCreateAdministratorTestPaymentResponses, SiteCreateAdministratorTestPaymentErrors, ThrowOnError> => (options.client ?? client).post<SiteCreateAdministratorTestPaymentResponses, SiteCreateAdministratorTestPaymentErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/test-payments',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const siteGetAdministratorOrderByMerchantNumber = <ThrowOnError extends boolean = false>(options: Options<SiteGetAdministratorOrderByMerchantNumberData, ThrowOnError>): RequestResult<SiteGetAdministratorOrderByMerchantNumberResponses, SiteGetAdministratorOrderByMerchantNumberErrors, ThrowOnError> => (options.client ?? client).get<SiteGetAdministratorOrderByMerchantNumberResponses, SiteGetAdministratorOrderByMerchantNumberErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/orders/by-merchant-no/{merchantOrderNo}',
    ...options
});
export const siteGetAdministratorOrder = <ThrowOnError extends boolean = false>(options: Options<SiteGetAdministratorOrderData, ThrowOnError>): RequestResult<SiteGetAdministratorOrderResponses, SiteGetAdministratorOrderErrors, ThrowOnError> => (options.client ?? client).get<SiteGetAdministratorOrderResponses, SiteGetAdministratorOrderErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/orders/{orderId}',
    ...options
});
export const siteOpenAdministratorOrderCheckout = <ThrowOnError extends boolean = false>(options: Options<SiteOpenAdministratorOrderCheckoutData, ThrowOnError>): RequestResult<unknown, SiteOpenAdministratorOrderCheckoutErrors, ThrowOnError> => (options.client ?? client).get<unknown, SiteOpenAdministratorOrderCheckoutErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/orders/{orderId}/checkout',
    ...options
});
export const siteListAdministratorOrderWebhookDeliveries = <ThrowOnError extends boolean = false>(options: Options<SiteListAdministratorOrderWebhookDeliveriesData, ThrowOnError>): RequestResult<SiteListAdministratorOrderWebhookDeliveriesResponses, SiteListAdministratorOrderWebhookDeliveriesErrors, ThrowOnError> => (options.client ?? client).get<SiteListAdministratorOrderWebhookDeliveriesResponses, SiteListAdministratorOrderWebhookDeliveriesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/orders/{orderId}/notifications/deliveries',
    ...options
});
export const siteSetAdministratorRefundMark = <ThrowOnError extends boolean = false>(options: Options<SiteSetAdministratorRefundMarkData, ThrowOnError>): RequestResult<SiteSetAdministratorRefundMarkResponses, SiteSetAdministratorRefundMarkErrors, ThrowOnError> => (options.client ?? client).put<SiteSetAdministratorRefundMarkResponses, SiteSetAdministratorRefundMarkErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/orders/{orderId}/refund-mark',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const siteListWebhookDeliveries = <ThrowOnError extends boolean = false>(options: Options<SiteListWebhookDeliveriesData, ThrowOnError>): RequestResult<SiteListWebhookDeliveriesResponses, SiteListWebhookDeliveriesErrors, ThrowOnError> => (options.client ?? client).get<SiteListWebhookDeliveriesResponses, SiteListWebhookDeliveriesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/webhooks/deliveries',
    ...options
});
export const siteGetWebhookDelivery = <ThrowOnError extends boolean = false>(options: Options<SiteGetWebhookDeliveryData, ThrowOnError>): RequestResult<SiteGetWebhookDeliveryResponses, SiteGetWebhookDeliveryErrors, ThrowOnError> => (options.client ?? client).get<SiteGetWebhookDeliveryResponses, SiteGetWebhookDeliveryErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/webhooks/deliveries/{deliveryId}',
    ...options
});
export const siteListWebhookDeliveryAttempts = <ThrowOnError extends boolean = false>(options: Options<SiteListWebhookDeliveryAttemptsData, ThrowOnError>): RequestResult<SiteListWebhookDeliveryAttemptsResponses, SiteListWebhookDeliveryAttemptsErrors, ThrowOnError> => (options.client ?? client).get<SiteListWebhookDeliveryAttemptsResponses, SiteListWebhookDeliveryAttemptsErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/webhooks/deliveries/{deliveryId}/attempts',
    ...options
});
export const siteRedeliverWebhookDelivery = <ThrowOnError extends boolean = false>(options: Options<SiteRedeliverWebhookDeliveryData, ThrowOnError>): RequestResult<SiteRedeliverWebhookDeliveryResponses, SiteRedeliverWebhookDeliveryErrors, ThrowOnError> => (options.client ?? client).post<SiteRedeliverWebhookDeliveryResponses, SiteRedeliverWebhookDeliveryErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/webhooks/deliveries/{deliveryId}/actions/redeliver',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const siteGetReconciliationCandidate = <ThrowOnError extends boolean = false>(options: Options<SiteGetReconciliationCandidateData, ThrowOnError>): RequestResult<SiteGetReconciliationCandidateResponses, SiteGetReconciliationCandidateErrors, ThrowOnError> => (options.client ?? client).get<SiteGetReconciliationCandidateResponses, SiteGetReconciliationCandidateErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/reconciliation/candidates/{candidateId}',
    ...options
});
export const siteGetPaymentMatch = <ThrowOnError extends boolean = false>(options: Options<SiteGetPaymentMatchData, ThrowOnError>): RequestResult<SiteGetPaymentMatchResponses, SiteGetPaymentMatchErrors, ThrowOnError> => (options.client ?? client).get<SiteGetPaymentMatchResponses, SiteGetPaymentMatchErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/reconciliation/matches/{paymentMatchId}',
    ...options
});
export const siteGetFinancialException = <ThrowOnError extends boolean = false>(options: Options<SiteGetFinancialExceptionData, ThrowOnError>): RequestResult<SiteGetFinancialExceptionResponses, SiteGetFinancialExceptionErrors, ThrowOnError> => (options.client ?? client).get<SiteGetFinancialExceptionResponses, SiteGetFinancialExceptionErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/reconciliation/exceptions/{exceptionId}',
    ...options
});
export const siteGetReconciliationLedgerEntry = <ThrowOnError extends boolean = false>(options: Options<SiteGetReconciliationLedgerEntryData, ThrowOnError>): RequestResult<SiteGetReconciliationLedgerEntryResponses, SiteGetReconciliationLedgerEntryErrors, ThrowOnError> => (options.client ?? client).get<SiteGetReconciliationLedgerEntryResponses, SiteGetReconciliationLedgerEntryErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/reconciliation/ledger-entries/{ledgerEntryId}',
    ...options
});
export const siteListLedgerEntryCandidates = <ThrowOnError extends boolean = false>(options: Options<SiteListLedgerEntryCandidatesData, ThrowOnError>): RequestResult<SiteListLedgerEntryCandidatesResponses, SiteListLedgerEntryCandidatesErrors, ThrowOnError> => (options.client ?? client).get<SiteListLedgerEntryCandidatesResponses, SiteListLedgerEntryCandidatesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/reconciliation/ledger-entries/{ledgerEntryId}/candidates',
    ...options
});
export const siteListManualSettlementLedgerEntries = <ThrowOnError extends boolean = false>(options: Options<SiteListManualSettlementLedgerEntriesData, ThrowOnError>): RequestResult<SiteListManualSettlementLedgerEntriesResponses, SiteListManualSettlementLedgerEntriesErrors, ThrowOnError> => (options.client ?? client).get<SiteListManualSettlementLedgerEntriesResponses, SiteListManualSettlementLedgerEntriesErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/{clientId}/reconciliation/settlements/manual/ledger-entries',
    ...options
});
export const siteCreateManualSettlement = <ThrowOnError extends boolean = false>(options: Options<SiteCreateManualSettlementData, ThrowOnError>): RequestResult<SiteCreateManualSettlementResponses, SiteCreateManualSettlementErrors, ThrowOnError> => (options.client ?? client).post<SiteCreateManualSettlementResponses, SiteCreateManualSettlementErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/reconciliation/settlements/manual',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const siteReversePaymentSettlement = <ThrowOnError extends boolean = false>(options: Options<SiteReversePaymentSettlementData, ThrowOnError>): RequestResult<SiteReversePaymentSettlementResponses, SiteReversePaymentSettlementErrors, ThrowOnError> => (options.client ?? client).post<SiteReversePaymentSettlementResponses, SiteReversePaymentSettlementErrors, ThrowOnError>({
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
    url: '/api/admin/v1/sites/{clientId}/reconciliation/matches/{paymentMatchId}/actions/reverse',
    ...options,
    headers: {
        'Content-Type': 'application/json',
        ...options.headers
    }
});
export const listSiteOverview = <ThrowOnError extends boolean = false>(options?: Options<ListSiteOverviewData, ThrowOnError>): RequestResult<ListSiteOverviewResponses, ListSiteOverviewErrors, ThrowOnError> => (options?.client ?? client).get<ListSiteOverviewResponses, ListSiteOverviewErrors, ThrowOnError>({
    security: [{
            in: 'cookie',
            name: '__Host-perpay_session',
            type: 'apiKey'
        }],
    url: '/api/admin/v1/sites/overview',
    ...options
});
