import { Link, useSearchParams } from "react-router";

export function Pagination({
  nextCursor,
  shownCount,
  totalCount,
}: {
  nextCursor: string | null;
  shownCount: number;
  totalCount: number;
}) {
  const [searchParams] = useSearchParams();
  const isPaged = searchParams.has("cursor");

  const nextParams = new URLSearchParams(searchParams);
  if (nextCursor) nextParams.set("cursor", nextCursor);
  const firstParams = new URLSearchParams(searchParams);
  firstParams.delete("cursor");

  const linkCls = "bevel-btn px-3 py-[3px] text-[11px] font-bold";
  const disabledCls = "bevel-btn px-3 py-[3px] text-[11px] font-bold text-gray-400 [text-shadow:1px_1px_0_#fff] cursor-default";

  return (
    <div className="flex items-center justify-between py-2">
      <p className="bevel-in bg-chrome px-2 py-[2px] text-[11px]">
        Page shows {shownCount} of {totalCount.toLocaleString()} ledger entries
      </p>
      <div className="flex gap-[3px]">
        {isPaged ? (
          <Link className={linkCls} to={`?${firstParams}`}>
            ⏮ Newest
          </Link>
        ) : (
          <span className={disabledCls}>⏮ Newest</span>
        )}
        {nextCursor ? (
          <Link className={linkCls} to={`?${nextParams}`}>
            Older ⏭
          </Link>
        ) : (
          <span className={disabledCls}>Older ⏭</span>
        )}
      </div>
    </div>
  );
}
