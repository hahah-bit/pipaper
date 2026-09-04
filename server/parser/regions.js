export function sourceBounds(block, blocks) {
  let box = block.bbox;
  if (block.type === "code" && block.algorithm) {
    const title = blocks[blocks.indexOf(block) - 1];
    if (title?.type === "heading" && title.algorithm && title.page === block.page && title.bbox &&
        title.bbox[3] <= box[1] + 3 && box[1] - title.bbox[3] < 24) {
      box = [Math.min(box[0], title.bbox[0]), Math.min(box[1], title.bbox[1]),
        Math.max(box[2], title.bbox[2]), Math.max(box[3], title.bbox[3])];
    }
  }
  return box.map((v, i) => v + (i < 2 ? -4 : 4));
}
