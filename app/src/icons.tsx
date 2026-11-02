// Toolbar icons: Lucide (ISC), inlined at build time so they inherit currentColor.
import copy from "lucide-static/icons/copy.svg?raw";
import shrink from "lucide-static/icons/minimize-2.svg?raw";
import chat from "lucide-static/icons/message-circle.svg?raw";
import check from "lucide-static/icons/copy-check.svg?raw";
import save from "lucide-static/icons/save.svg?raw";
import link from "lucide-static/icons/link.svg?raw";
import saveAs from "lucide-static/icons/file-down.svg?raw";
import editable from "lucide-static/icons/file-pen-line.svg?raw";
import close from "lucide-static/icons/x.svg?raw";
import step from "lucide-static/icons/list-ordered.svg?raw";
import pixelate from "lucide-static/icons/grid-3x3.svg?raw";
import blur from "lucide-static/icons/droplets.svg?raw";
import black from "lucide-static/icons/square.svg?raw";
import spot from "lucide-static/icons/scan-eye.svg?raw";
import smile from "lucide-static/icons/smile-plus.svg?raw";
import sparkles from "lucide-static/icons/sparkles.svg?raw";
import info from "lucide-static/icons/info.svg?raw";
import mic from "lucide-static/icons/mic.svg?raw";
import layout from "lucide-static/icons/layout-panel-top.svg?raw";
import pointer from "lucide-static/icons/mouse-pointer-2.svg?raw";
import arrow from "lucide-static/icons/move-up-right.svg?raw";
import line from "lucide-static/icons/minus.svg?raw";
import rect from "lucide-static/icons/square.svg?raw";
import ellipse from "lucide-static/icons/circle.svg?raw";
import pen from "lucide-static/icons/pencil.svg?raw";
import highlight from "lucide-static/icons/highlighter.svg?raw";
import text from "lucide-static/icons/type.svg?raw";
import magnify from "lucide-static/icons/zoom-in.svg?raw";
import crop from "lucide-static/icons/crop.svg?raw";
import pipette from "lucide-static/icons/pipette.svg?raw";
import undo from "lucide-static/icons/undo-2.svg?raw";
import redo from "lucide-static/icons/redo-2.svg?raw";
import trash from "lucide-static/icons/trash-2.svg?raw";
import duplicate from "lucide-static/icons/copy-plus.svg?raw";
import front from "lucide-static/icons/bring-to-front.svg?raw";
import back from "lucide-static/icons/send-to-back.svg?raw";
import fit from "lucide-static/icons/maximize.svg?raw";
import shadow from "lucide-static/icons/sun-dim.svg?raw";

const svgs = {
  copy, shrink, chat, check, save, link, saveAs, editable, close, step, pixelate, blur, black, spot, smile, sparkles, info, mic, layout,
  pointer, arrow, line, rect, ellipse, pen, highlight, text, magnify, crop, pipette, undo, redo, trash, duplicate, front, back, fit, shadow,
};
export type IconName = keyof typeof svgs;

export function Icon({ name }: { name: IconName }) {
  return <span className="ico" aria-hidden dangerouslySetInnerHTML={{ __html: svgs[name] }} />;
}
