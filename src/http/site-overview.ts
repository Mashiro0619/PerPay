import type { AppDatabase } from "../database/database.ts";
import { siteConfigurationSchema } from "../sites/model.ts";
import { ListQueryError } from "../shared/list-query.ts";
import { WORK_ITEMS_CTE } from "./admin-work-items.ts";
import { decodeListCursor, encodeListCursor } from "./list-cursor.ts";
export function siteOverview(database: AppDatabase, values: URLSearchParams, now = Date.now()) {
    for (const key of values.keys())
        if (!["q", "range", "limit", "cursor"].includes(key) || values.getAll(key).length !== 1)
            throw new ListQueryError("网站概览查询无效");
    const q = values.get("q") ?? "", range = Number(values.get("range") ?? 30), limit = Number(values.get("limit") ?? 20);
    if (q.length > 128 || ![7, 30, 90].includes(range) || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new ListQueryError("网站概览查询无效");
    const cursor = values.get("cursor");
    const position = cursor ? decodeListCursor(cursor, "site-overview", [q, range], "string") : null;
    if (cursor && (!position || typeof position.value !== "string"))
        throw new ListQueryError("网站概览游标无效");
    const day = 86400000, end = Math.floor((now + 8 * 3600000) / day) * day - 8 * 3600000 + day, start = end - range * day;
    return database.read(db => {
        const rows = db.prepare("SELECT client_id, configuration FROM sites WHERE deleted_at IS NULL AND (? IS NULL OR client_id > ?) AND (? = '' OR instr(lower(client_id),lower(?)) > 0 OR instr(lower(json_extract(configuration,'$.name')),lower(?)) > 0) ORDER BY client_id LIMIT ?").all(position?.value ?? null, position?.value ?? null, q, q, q, limit + 1) as Array<{
            client_id: string;
            configuration: string;
        }>;
        const selected = rows.slice(0, limit), ids = JSON.stringify(selected.map(row => row.client_id));
        const pending = db.prepare("SELECT api_client_id, count(*) AS n FROM payment_orders WHERE checkout_status = 'OPEN' AND payment_status = 'UNPAID' AND api_client_id IN (SELECT value FROM json_each(?)) GROUP BY api_client_id").all(ids);
        const confirmed = db.prepare("SELECT o.api_client_id, count(*) AS n, sum(o.received_amount_cents) AS amount FROM order_events e JOIN payment_orders o ON o.order_id = e.order_id WHERE e.event_type = 'PAYMENT_CONFIRMED' AND e.occurred_at >= ? AND e.occurred_at < ? AND o.api_client_id IN (SELECT value FROM json_each(?)) GROUP BY o.api_client_id").all(start, end, ids);
        const work = db.prepare(WORK_ITEMS_CTE + " SELECT o.api_client_id, count(*) AS n FROM work_items w JOIN payment_orders o ON o.order_id = w.order_id WHERE w.ignored = 0 AND w.actionable = 1 AND o.api_client_id IN (SELECT value FROM json_each(?)) GROUP BY o.api_client_id").all(ids);
        const byId = (values: typeof pending) => new Map(values.map(row => [String(row.api_client_id), row]));
        const p = byId(pending), c = byId(confirmed), w = byId(work);
        return { data: selected.map(row => {
                const config = siteConfigurationSchema.parse(JSON.parse(row.configuration));
                return { client_id: row.client_id, name: config.name, accepting_orders: config.accepting_orders, notifications_enabled: config.notifications_enabled,
                    confirmed_count: Number(c.get(row.client_id)?.n ?? 0), confirmed_amount_cents: Number(c.get(row.client_id)?.amount ?? 0),
                    pending_orders: Number(p.get(row.client_id)?.n ?? 0), work_items: Number(w.get(row.client_id)?.n ?? 0) };
            }), page: { next_cursor: rows.length > limit ? encodeListCursor("site-overview", [q, range], { value: selected.at(-1)!.client_id, keys: ["site"] }) : null } };
    });
}
