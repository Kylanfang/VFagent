import { groundingCheck, aiLikeness } from "../server/lib/aigc-monitor.mjs";

const svg = "```svg\n<svg viewBox=\"0 0 600 120\">\n  <rect width=\"600\" height=\"120\"/>\n</svg>\n```\n结论：营收 45.2 万元，增长 12%。";
console.log("grounded case:", JSON.stringify(groundingCheck(svg, "证据里有 45.2 万元 增长 12%")));
console.log("halluc case:", JSON.stringify(groundingCheck("本期营收 99.8 万元", "证据里只有 45.2 万元")));
console.log("ai human:", JSON.stringify(aiLikeness("帮我看看这个月报表哪里有问题，我算了半天对不上，麻烦你了")));
console.log("ai machine:", JSON.stringify(aiLikeness("综上所述，本季度整体运营情况良好。首先，营收稳步增长。其次，成本得到有效控制。最后，需要注意以下几点风险。此外，建议持续优化。")));
