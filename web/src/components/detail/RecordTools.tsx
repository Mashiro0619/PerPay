import { useId, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { MoreActions, type MenuAction } from "../MoreActions";
import { Button, CopyValue } from "../ui";
import { DetailFields } from "./DetailPrimitives";

export function RecordTools({ data, identifiers = [], actions = [], to, label = "记录操作" }: {
  data: unknown; identifiers?: ReadonlyArray<readonly [string, string | null]>; actions?: readonly MenuAction[]; to?: string | undefined; label?: string;
}) {
  const [show, setShow] = useState(false); const heading = useRef<HTMLHeadingElement>(null); const container = useRef<HTMLDivElement>(null); const id = useId();
  useLayoutEffect(() => { if (show) heading.current?.focus({ preventScroll: true }); }, [show]);
  return <div className="record-tools" ref={container}>
    {actions.length || to ? <MoreActions label={label} actions={[...actions, { label: show ? "收起技术详情" : "技术详情", onSelect: () => setShow(value => !value) }, ...(to ? [{ label: "单独打开", to }] : [])]} />
      : <Button variant="quiet" className="more-trigger" aria-label={label} aria-expanded={show} aria-controls={show ? id : undefined} onClick={() => setShow(value => !value)}>{show ? "收起技术详情" : "技术详情"}</Button>}
    {show && <section id={id} className="record-technical" aria-labelledby={id + "-heading"}><header><h4 ref={heading} id={id + "-heading"} tabIndex={-1}>技术详情</h4><Button variant="quiet" className="icon-button" aria-label="收起技术详情" onClick={() => { setShow(false); container.current?.querySelector<HTMLElement>('.more-trigger')?.focus(); }}><X size={16} /></Button></header>
      {!!identifiers.length && <DetailFields items={identifiers.filter((entry): entry is readonly [string, string] => !!entry[1]).map(([name, value]) => [name, <CopyValue value={value} label={"复制" + name} />])} />}
      <pre className="detail-raw">{JSON.stringify(data, null, 2)}</pre>
    </section>}
  </div>;
}
