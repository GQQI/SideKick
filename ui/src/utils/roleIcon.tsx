import {
  IconBinoculars,
  IconBraces,
  IconCube,
  IconRobot,
} from "../components/icons";

export function roleIcon(role: string) {
  const r = role.toLowerCase();
  if (r.includes("research") || r.includes("调研") || r.includes("搜索"))
    return <IconBinoculars size={15} />;
  if (r.includes("code") || r.includes("coder") || r.includes("编码") || r.includes("开发"))
    return <IconBraces size={15} />;
  if (r.includes("tool") || r.includes("工具")) return <IconCube size={15} />;
  return <IconRobot size={15} />;
}
