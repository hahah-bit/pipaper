// markmap 思维导图渲染：视频面板与沉浸工作台共用的入口。
// 返回 Markmap 实例，调用方可做 fit()/rescale() 等后续操作。
// 注意：必须等 setData 的布局/过渡完成后再 fit，否则会按错误的尺寸缩放（截断或过小）。
export async function renderMarkmap(svgEl, md, opts = {}) {
  const { Transformer } = await import("markmap-lib");
  const { Markmap } = await import("markmap-view");
  svgEl.replaceChildren();
  const tr = new Transformer();
  const root = tr.transform(md || "# 空").root;
  const mm = Markmap.create(svgEl, {
    duration: 300,
    maxWidth: 260,
    zoom: true,   // 滚轮缩放
    pan: true,    // 拖拽平移
    autoFit: false, // 尺寸自适应由调用方在布局完成后 fit，避免竞态
    ...opts,
  });
  await mm.setData(root);
  await mm.fit();
  return mm;
}
