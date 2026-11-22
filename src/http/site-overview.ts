import type { AppDatabase } from "../database/database.ts";
import { siteConfigurationSchema } from "../sites/model.ts";
import { ListQueryError } from "../shared/list-query.ts";
import { WORK_ITEMS_CTE } from "./admin-work-items.ts";
import { decodeListCursor, encodeListCursor } from "./list-cursor.ts";

const CONFIRMATION_TOTALS_SQL = `
    SELECT o.api_client_id, count(*) AS n, sum(json_extract(e.payload_json, '$.received_amount_cents')) AS amount
      FROM outbox_events e JOIN payment_orders o ON o.order_id = e.aggregate_id
     WHERE e.event_type = 'PAYMENT_CONFIRMED'
       AND e.created_at >= ? AND e.created_at < ?
`;

const SORT_FIELDS = ["client_id", "amount", "work_items"] as const;
type SiteOverviewSort = (typeof SORT_FIELDS)[number];

export function siteOverview(database: AppDatabase, values: URLSearchParams, now = Date.now()) {
    for (const key of values.keys())
        if (!["q", "range", "limit", "cursor", "sort_by"].includes(key) || values.getAll(key).length !== 1)
            throw new ListQueryError("网站概览查询无效");
    const q = values.get("q") ?? "", range = Number(values.get("range") ?? 30), limit = Number(values.get("limit") ?? 20);
    const sortBy = (values.get("sort_by") ?? "client_id") as SiteOverviewSort;
    if (q.length > 128 || ![7, 30, 90].includes(range) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !SORT_FIELDS.includes(sortBy))
        throw new ListQueryError("网站概览查询无效");
    const cursor = values.get("cursor");
    const cursorBinding = [q, range, sortBy];
    const position = cursor
        ? decodeListCursor(cursor, "site-overview", cursorBinding, sortBy === "client_id" ? "string" : "number", sortBy === "client_id" ? 1 : 2)
        : null;
    if (cursor && !position)
        throw new ListQueryError("网站概览游标无效");
    if (position && sortBy === "client_id" && typeof position.value !== "string")
        throw new ListQueryError("网站概览游标无效");
    if (position && sortBy === "amount" && (typeof position.value !== "number" || !["0", "1"].includes(position.keys[0]!)))
        throw new ListQueryError("网站概览游标无效");
    if (position && sortBy === "work_items" && (typeof position.value !== "number" || !/^(0|[1-9][0-9]{0,14})$/.test(position.keys[0]!) || !Number.isSafeInteger(Number(position.keys[0]))))
        throw new ListQueryError("网站概览游标无效");
    const day = 86400000, end = Math.floor((now + 8 * 3600000) / day) * day - 8 * 3600000 + day, start = end - range * day;
    const period = {
        from: new Date(start + 8 * 3600000).toISOString().slice(0, 10),
        to: new Date(end - day + 8 * 3600000).toISOString().slice(0, 10),
    };
    return database.read(db => {
        const hasPublicIds = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='site_api_client_ids'").get() !== undefined;
        const publicId = hasPublicIds ? "identity.api_client_id" : "site.client_id";
        const publicJoin = hasPublicIds ? "JOIN site_api_client_ids AS identity ON identity.client_id=site.client_id AND identity.is_current=1" : "";
        const searchPredicate = `(? = '' OR instr(lower(${publicId}),lower(?)) > 0 OR instr(lower(json_extract(site.configuration,'$.name')),lower(?)) > 0)`;
        let rows: Array<{
            client_id: string;
            api_client_id: string;
            configuration: string;
        }>;
        if (sortBy === "amount") {
            const acceptingExpr = "CASE WHEN json_extract(site.configuration,'$.accepting_orders') = 1 THEN 1 ELSE 0 END";
            const cursorAmount = position ? Number(position.value) : null;
            const cursorAccepting = position ? Number(position.keys[0]) : null;
            const cursorClientId = position ? position.keys[1]! : null;
            rows = db.prepare(`
                WITH confirmed_totals AS (
                    ${CONFIRMATION_TOTALS_SQL}
                    GROUP BY o.api_client_id
                )
                SELECT site.client_id, ${publicId} AS api_client_id, site.configuration
                  FROM sites AS site
                  ${publicJoin}
                  LEFT JOIN confirmed_totals AS ct ON ct.api_client_id = site.client_id
                 WHERE site.deleted_at IS NULL
                   AND (? IS NULL
                        OR coalesce(ct.amount, 0) < ?
                        OR (coalesce(ct.amount, 0) = ? AND (${acceptingExpr}) < ?)
                        OR (coalesce(ct.amount, 0) = ? AND (${acceptingExpr}) = ? AND site.client_id > ?))
                   AND ${searchPredicate}
                 ORDER BY coalesce(ct.amount, 0) DESC, (${acceptingExpr}) DESC, site.client_id ASC
                 LIMIT ?
            `).all(
                start, end,
                cursorAmount, cursorAmount, cursorAmount, cursorAccepting, cursorAmount, cursorAccepting, cursorClientId,
                q, q, q, limit + 1,
            ) as typeof rows;
        } else if (sortBy === "work_items") {
            const cursorWork = position ? Number(position.value) : null;
            const cursorAmount = position ? Number(position.keys[0]) : null;
            const cursorClientId = position ? position.keys[1]! : null;
            rows = db.prepare(`
                ${WORK_ITEMS_CTE},
                work_totals AS (
                    SELECT o.api_client_id, count(*) AS n
                      FROM work_items w JOIN payment_orders o ON o.order_id = w.order_id
                     WHERE w.ignored = 0 AND w.actionable = 1
                     GROUP BY o.api_client_id
                ),
                confirmed_totals AS (
                    ${CONFIRMATION_TOTALS_SQL}
                    GROUP BY o.api_client_id
                )
                SELECT site.client_id, ${publicId} AS api_client_id, site.configuration
                  FROM sites AS site
                  ${publicJoin}
                  LEFT JOIN work_totals AS wt ON wt.api_client_id = site.client_id
                  LEFT JOIN confirmed_totals AS ct ON ct.api_client_id = site.client_id
                 WHERE site.deleted_at IS NULL
                   AND (? IS NULL
                        OR coalesce(wt.n, 0) < ?
                        OR (coalesce(wt.n, 0) = ? AND coalesce(ct.amount, 0) < ?)
                        OR (coalesce(wt.n, 0) = ? AND coalesce(ct.amount, 0) = ? AND site.client_id > ?))
                   AND ${searchPredicate}
                 ORDER BY coalesce(wt.n, 0) DESC, coalesce(ct.amount, 0) DESC, site.client_id ASC
                 LIMIT ?
            `).all(
                start, end,
                cursorWork, cursorWork, cursorWork, cursorAmount, cursorWork, cursorAmount, cursorClientId,
                q, q, q, limit + 1,
            ) as typeof rows;
        } else {
            rows = db.prepare(`
                SELECT site.client_id, ${publicId} AS api_client_id, site.configuration
                  FROM sites AS site
                  ${publicJoin}
                 WHERE site.deleted_at IS NULL AND (? IS NULL OR site.client_id > ?)
                   AND ${searchPredicate}
                 ORDER BY site.client_id LIMIT ?
            `).all(position?.value ?? null, position?.value ?? null, q, q, q, limit + 1) as typeof rows;
        }
        const selected = rows.slice(0, limit), ids = JSON.stringify(selected.map(row => row.client_id));
        const pending = db.prepare("SELECT api_client_id, count(*) AS n FROM payment_orders WHERE checkout_status = 'OPEN' AND payment_status = 'UNPAID' AND expires_at > ? AND api_client_id IN (SELECT value FROM json_each(?)) GROUP BY api_client_id").all(now, ids);
        const confirmed = db.prepare(CONFIRMATION_TOTALS_SQL + " AND o.api_client_id IN (SELECT value FROM json_each(?)) GROUP BY o.api_client_id").all(start, end, ids);
        const work = db.prepare(WORK_ITEMS_CTE + " SELECT o.api_client_id, count(*) AS n FROM work_items w JOIN payment_orders o ON o.order_id = w.order_id WHERE w.ignored = 0 AND w.actionable = 1 AND o.api_client_id IN (SELECT value FROM json_each(?)) GROUP BY o.api_client_id").all(ids);
        const totals = db.prepare(`
            SELECT
                (SELECT count(*) FROM sites WHERE deleted_at IS NULL) AS total_sites,
                coalesce(max(amount), 0) AS max_amount,
                coalesce(sum(amount), 0) AS total_amount
              FROM (
                ${CONFIRMATION_TOTALS_SQL}
                  AND o.api_client_id IN (SELECT client_id FROM sites WHERE deleted_at IS NULL)
                GROUP BY o.api_client_id
            )
        `).get(start, end);
        const byId = (values: typeof pending) => new Map(values.map(row => [String(row.api_client_id), row]));
        const p = byId(pending), c = byId(confirmed), w = byId(work);
        const data = selected.map(row => {
            const config = siteConfigurationSchema.parse(JSON.parse(row.configuration));
            return { client_id: row.client_id, api_client_id: row.api_client_id, name: config.name, accepting_orders: config.accepting_orders, notifications_enabled: config.notifications_enabled,
                confirmed_count: Number(c.get(row.client_id)?.n ?? 0), confirmed_amount_cents: Number(c.get(row.client_id)?.amount ?? 0),
                pending_orders: Number(p.get(row.client_id)?.n ?? 0), work_items: Number(w.get(row.client_id)?.n ?? 0) };
        });
        const last = data.at(-1);
        const nextCursor = rows.length > limit && last
            ? sortBy === "amount"
                ? encodeListCursor("site-overview", cursorBinding, { value: last.confirmed_amount_cents, keys: [last.accepting_orders ? "1" : "0", last.client_id] })
                : sortBy === "work_items"
                    ? encodeListCursor("site-overview", cursorBinding, { value: last.work_items, keys: [String(last.confirmed_amount_cents), last.client_id] })
                    : encodeListCursor("site-overview", cursorBinding, { value: last.client_id, keys: ["site"] })
            : null;
        return {
            period,
            max_confirmed_amount_cents: Number(totals?.max_amount ?? 0),
            total_confirmed_amount_cents: Number(totals?.total_amount ?? 0),
            total_sites: Number(totals?.total_sites ?? 0),
            data,
            page: { next_cursor: nextCursor },
        };
    });
}
