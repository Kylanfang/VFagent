// 审计库字段名 → 中文标签（表头 / 键值表 / 编辑弹层共用）。未收录的字段回退为自动拆词。
export const FIELD_LABEL = {
  id: "编号", name: "名称", title: "标题", type: "类型", status: "状态", level: "等级", severity: "严重度",
  department: "部门", businessLine: "业务线", description: "描述", summary: "摘要", content: "内容", details: "详情",
  createdAt: "创建时间", updatedAt: "更新时间", createdBy: "创建人", creator: "创建人", operator: "操作人", operatedAt: "操作时间",
  completedAt: "完成时间", detectedAt: "发现时间", generatedAt: "生成时间", quantifiedAt: "量化时间", uploadedAt: "上传时间", uploadedBy: "上传人",
  changedAt: "变更时间", lastUpdated: "最近更新", lastDeployedAt: "最近部署", effectiveDate: "生效日期", deadline: "截止日期", date: "日期", time: "时间",
  month: "月份", period: "期间", fromPeriod: "起始期", toPeriod: "结束期",
  assignee: "负责人", responsiblePerson: "责任人", approver: "审批人", approvalStatus: "审批状态", reviews: "评审", recommendation: "建议", recommendedAction: "建议动作",
  progress: "进度", result: "结果", conclusion: "结论", findings: "发现", evidence: "证据", evidences: "证据清单", documents: "文档", files: "文件", fileUrl: "文件地址", fileSize: "文件大小", documentType: "文档类型",
  taskId: "任务编号", taskName: "任务名称", templateId: "模板编号", templateName: "模板名称", isStandard: "标准模板", isDefault: "默认", currentVersion: "当前版本", versions: "版本",
  code: "编码", ruleId: "规则编号", ruleTitle: "规则标题", category: "分类", enabled: "启用", threshold: "阈值", weights: "权重", fields: "字段", items: "条目", count: "数量", percentage: "占比", rank: "排名",
  scenario: "场景", auditScenarios: "审计场景", useCases: "用例", module: "模块", system: "系统", systems: "系统", sourceSystems: "来源系统", source: "来源", sourceName: "来源名称", sourceType: "来源类型", dataSource: "数据源", target: "目标",
  employeeId: "员工编号", employeeName: "员工姓名", username: "用户名", userId: "用户编号", position: "岗位", hireDate: "入职日期", tenure: "司龄", compensation: "薪酬",
  candidateId: "候选人编号", candidateName: "候选人", recruiter: "招聘负责人", backgroundCheck: "背景调查", materialsReview: "材料审核", contractSigning: "合同签署", contractClauses: "合同条款",
  attendance: "考勤", attendanceRecords: "考勤记录", overtime: "加班", awardRecords: "奖惩记录", positionChanges: "岗位变动", changeType: "变更类型", oldValue: "变更前", newValue: "变更后",
  fromDepartment: "原部门", toDepartment: "新部门", fromPosition: "原岗位", toPosition: "新岗位", fromLevel: "原职级", toLevel: "新职级", fromSalary: "原薪酬", toSalary: "新薪酬",
  departureDate: "离职日期", departureType: "离职类型", exitChecklist: "离职清单", leaveAnalysis: "离职分析", salarySyncStatus: "薪酬同步状态",
  accountId: "账号编号", accountStatus: "账号状态", accountHealth: "账号健康度", accountRecovery: "账号回收", totalAccounts: "账号总数", totalEmployees: "员工总数", orphanAccounts: "孤儿账号", unassignedAccounts: "未分配账号", multiAccountUsers: "多账号用户",
  permissionLevel: "权限级别", permissionName: "权限名称", requestedPermissions: "申请权限", privacyRequests: "隐私请求", dataClassification: "数据分级", accessLogs: "访问日志", ipAddress: "IP 地址",
  reconDate: "对账日期", reconResult: "对账结果", inconsistencies: "不一致项", checkResult: "检查结果", checkTime: "检查时间", complianceChecks: "合规检查", compliance: "合规性", gapDescription: "差距说明", rectificationRequirements: "整改要求", rectificationRecords: "整改记录",
  riskId: "风险编号", riskTitle: "风险标题", riskType: "风险类型", riskLevel: "风险等级", riskDimension: "风险维度", riskCount: "风险数", risks: "风险", riskFlags: "风险标记", riskSentences: "风险语句",
  totalRisks: "风险总数", highRiskCount: "高风险数", mediumRiskCount: "中风险数", lowRiskCount: "低风险数", pendingTickets: "待整改工单", closedCount: "已关闭数", closureRate: "关闭率", transactionAnomalyRate: "交易异常率",
  impactScore: "影响分", probabilityScore: "概率分", overallScore: "综合分", averageScore: "平均分", correlationScore: "关联分", confidence: "置信度", aiConfidence: "AI 置信度", aiModel: "AI 模型", modelId: "模型编号", apiUrl: "接口地址", apiKey: "接口密钥",
  anomalies: "异常项", anomalyType: "异常类型", anomalyDetection: "异常检测", deviationDetails: "偏差详情", affectedArea: "影响范围", affectedData: "影响数据", relatedEntities: "关联实体", keyEntities: "关键实体", keywords: "关键词",
  cluesFound: "发现线索", analysisName: "分析名称", semanticSummary: "语义摘要", transcription: "转写文本", speakers: "说话人", duration: "时长", verified: "已核实", verificationStatus: "核实状态",
  invoiceNumber: "发票号码", invoiceCode: "发票代码", invoiceType: "发票类型", amount: "金额", taxAmount: "税额", buyer: "购方", seller: "销方",
  process: "流程", processNodes: "流程节点", action: "动作", reason: "原因", metrics: "指标", dataPoints: "数据点", samplingConfig: "抽样配置", samplingResults: "抽样结果", explanationConfig: "解释配置",
  inferenceLogs: "推理日志", trainingLogs: "训练日志", operationLogs: "操作日志", dimensions: "维度", cells: "单元格", sections: "分区",
};

/** 未收录字段：camelCase → 空格分词，首字母大写 */
export function fieldLabel(key) {
  if (FIELD_LABEL[key]) return FIELD_LABEL[key];
  const s = String(key ?? "");
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
