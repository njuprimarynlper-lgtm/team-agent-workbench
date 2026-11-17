import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir=path.resolve('docs/error-audit');
const before=JSON.parse(await fs.readFile(path.join(dir,'native-launcher-export-before-observation.json'),'utf8'));
const after=JSON.parse(await fs.readFile(path.join(dir,'native-launcher-export-after-observation.json'),'utf8'));
const result=JSON.parse(await fs.readFile(path.resolve('.test-data/error-audit/launcher-export-after/result.json'),'utf8'));
assert.equal(result.retry,true);assert(before.accessibility?.tree&&after.accessibility?.tree);
await fs.writeFile(path.join(dir,'native-export-scenarios.json'),JSON.stringify([{
 id:'native-launcher-export',role:'用户／管理员',entry:'启动窗口／导出故障报告失败',condition:'实际导出器遇到已有目标文件，保存没有完成；两处启动导出入口使用相同恢复流程',
 source:'scripts/start-dev-hidden.ps1 → scripts/startup-failure.ps1 → scripts/startup-error-dialog.cs#ShowExportFailure',
 changeReason:'原框只显示Open调用异常和文件路径，既不说明结果，也没有可执行的恢复选项。现在说明报告没有完整保存，并允许重新选择位置或取消；技术原文只记日志。',
 beforeVersion:'original-baseline',baselineNote:'本轮新增补查：原 UI 来自 d4d51bb 的真实 MessageBox 表达式和隔离导出器的真实 IO 异常；现 UI 直接使用生产 WinForms 类。Windows 原生自动布局／DPI决定窗口尺寸，没有裁切或合成图片。',
 beforeScreenshot:'screenshots/native-launcher-export-before.jpg',afterScreenshot:'screenshots/native-launcher-export-after.jpg',beforeUI:before.accessibility.tree,afterUI:after.accessibility.tree,
 readabilityRound:2,pass:true,capture:'actual native WinForms captured with computer-use:computer-use; C# GUI host, no terminal app automation',
 validation:{screenshots:'native-launcher-export-*-observation.json',retryReturn:result,productionFlowTests:'tests/launcher.test.ts: retry destination, cancel after failure, cancel picker, common UI callers, CLI behavior unchanged',normalCancel:'Node folder picker cancellation restored to OperationCanceledException / exit 2, no fabricated absent error screenshot'},
}],null,2));
console.log('Actual export before/after captures and retry return registered.');
