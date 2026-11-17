using System;
using System.Drawing;
using System.Windows.Forms;

// Shared by the actual launcher and its isolated native UI verification.
public static class WorkbenchStartupFailureDialog {
    public static bool Show(string message) {
        return ShowChoice("工作台未能启动", message, "导出故障报告", "关闭");
    }
    public static bool ShowExportFailure() {
        return ShowChoice("故障报告未保存", "故障报告没能完整保存。请换一个保存位置后再试。", "重新选择位置", "取消导出");
    }
    private static bool ShowChoice(string title, string message, string confirmText, string cancelText) {
        Application.EnableVisualStyles();
        using (var form = new Form()) {
            form.Text = title;
            form.AutoScaleMode = AutoScaleMode.Font;
            form.Font = new Font("Microsoft YaHei UI", 9F);
            form.ClientSize = new Size(520, 200);
            form.StartPosition = FormStartPosition.CenterScreen;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            var icon = new PictureBox { Image = SystemIcons.Error.ToBitmap(), Location = new Point(24, 25), Size = new Size(32, 32) };
            var text = new Label { Text = message, Location = new Point(72, 24), Size = new Size(420, 116), AutoSize = false };
            var close = new Button { Text = cancelText, DialogResult = DialogResult.Cancel, Location = new Point(270, 154), Size = new Size(90, 30) };
            var export = new Button { Text = confirmText, DialogResult = DialogResult.OK, Location = new Point(370, 154), Size = new Size(126, 30) };
            form.Controls.AddRange(new Control[] { icon, text, close, export });
            form.AcceptButton = export;
            form.CancelButton = close;
            return form.ShowDialog() == DialogResult.OK;
        }
    }
}
