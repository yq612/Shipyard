import { useQueryClient, type Query, type QueryKey } from "@tanstack/react-query";

// 轮询连续失败这么多次（每次已含 TanStack Query 自己的重试）就停下，不再自动请求。
// 状态只存在内存里，刷新页面后重新计数；手动操作（切换页面等）成功一次也会恢复。
const MAX_FAILURES = 3;

// Query -> its errorUpdateCount as of the last successful fetch.
const baseline = new WeakMap<Query<any, any, any, any>, number>();

export function pollStopped(query: Query<any, any, any, any>): boolean {
  const { status, errorUpdateCount } = query.state;
  if (status === "success") baseline.set(query, errorUpdateCount);
  return errorUpdateCount - (baseline.get(query) ?? 0) >= MAX_FAILURES;
}

// refetchInterval that switches itself off once the query keeps failing.
export function pollEvery<T>(ms: number | ((query: Query<T, any, T, any>) => number)) {
  return (query: Query<T, any, T, any>): number | false =>
    pollStopped(query) ? false : typeof ms === "number" ? ms : ms(query);
}

export function usePollStopped(queryKey: QueryKey): boolean {
  const query = useQueryClient().getQueryCache().find({ queryKey, exact: true });
  return query ? pollStopped(query) : false;
}
