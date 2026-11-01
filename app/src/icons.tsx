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

const svgs = { copy, shrink, chat, check, save, link, saveAs, editable, close, step, pixelate, blur, black, spot, smile, sparkles, info };
export type IconName = keyof typeof svgs;

export function Icon({ name }: { name: IconName }) {
  return <span className="ico" aria-hidden dangerouslySetInnerHTML={{ __html: svgs[name] }} />;
}
