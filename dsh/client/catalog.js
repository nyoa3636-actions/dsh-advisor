/** Model catalog helpers: turn the DSH session model catalog into picker rows. */

/** The profile entry id the bundle's patch inserts for this plugin. */
export const ADVISOR_NAMESPACE_HINT = "dsh-advisor";

/**
 * Flatten `ctx.remote.session.modelCatalog()` into provider/model rows.
 * The catalog is the authority on which reasoning efforts a model accepts, so
 * the picker never offers an effort the provider would reject.
 */
export function modelRows(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const rows = [];
  for (const group of groups) {
    for (const model of group?.models ?? []) {
      rows.push({
        efforts: Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : [],
        group: group.id,
        groupName: group.name ?? group.id,
        id: model?.id ?? "",
        name: model?.name ?? model?.id ?? "",
        ref: `${group?.id ?? ""}/${model?.id ?? ""}`,
      });
    }
  }
  return rows;
}

export function findRow(rows, ref) {
  const key = String(ref ?? "").trim().toLowerCase();
  if (!key) return undefined;
  return rows.find((row) => row.ref.toLowerCase() === key);
}

export function effortsFor(rows, ref) {
  const row = findRow(rows, ref);
  return row?.efforts ?? [];
}

/**
 * Reduce a configured reasoning effort to one the model accepts.
 * Returns "" when no effort should be sent.
 */
export function effectiveEffort(rows, ref, requested) {
  const efforts = effortsFor(rows, ref);
  const wanted = String(requested ?? "").trim().toLowerCase();
  if (!wanted) return "";
  if (!efforts.length) return "";
  return efforts.some((effort) => String(effort.id).toLowerCase() === wanted) ? requested : "";
}

export function catalogFailures(catalog) {
  return Array.isArray(catalog?.failures) ? catalog.failures : [];
}

/** Resolve the Advisor settings namespace from the shared settings mirror. */
export function resolveNamespace(namespaces, hint = ADVISOR_NAMESPACE_HINT) {
  const list = [...(namespaces ?? [])];
  const direct = list.find((view) => String(view?.ns).toLowerCase() === hint);
  if (direct) return direct;
  // A pinned profile may name the entry something else; the Advisor field itself
  // is then the reliable marker.
  return list.find((view) => nameOfService(view) !== undefined);
}

function nameOfService(view) {
  // A serialized Config schema nests fields under `dict`; JSON Schema style
  // views use `properties`.
  const properties = view?.schema?.dict ?? view?.schema?.properties ?? {};
  if (properties.advisor || properties.advisorEnabled) return "advisor";
  return undefined;
}
