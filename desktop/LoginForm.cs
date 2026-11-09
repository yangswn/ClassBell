using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ClassBell
{
    internal sealed class LoginForm : Form
    {
        private readonly string dataDir;
        private readonly MainForm owner;
        private readonly CoreWebView2Environment sharedEnvironment;
        private WebView2 webView;
        private Label status;
        private System.Windows.Forms.Timer timer;
        private bool pushing;
        private bool logged;
        private string lastUrl = "";

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        public LoginForm(string dataDir, MainForm owner, CoreWebView2Environment environment)
        {
            this.dataDir = dataDir;
            this.owner = owner;
            this.sharedEnvironment = environment;
            Text = "学习通登录 · 课铃 ClassBell";
            StartPosition = FormStartPosition.CenterParent;
            Width = 1000;
            Height = 780;
            MinimumSize = new Size(760, 580);
            BackColor = Color.FromArgb(247, 245, 239);
            AutoScaleMode = AutoScaleMode.Dpi;
            try { Icon = new Icon(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets", "icon.ico")); } catch { }

            var top = new Panel { Dock = DockStyle.Top, Height = 44, BackColor = Color.FromArgb(20, 62, 51), Padding = new Padding(16, 0, 16, 0) };
            var title = new Label
            {
                Text = "学习通登录",
                ForeColor = Color.FromArgb(250, 246, 234),
                Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(16, 13)
            };
                status = new Label
            {
                Text = "扫码或输入账号，登录成功后关闭本窗口",
                ForeColor = Color.FromArgb(196, 214, 202),
                Font = new Font("Microsoft YaHei UI", 8.5F),
                AutoSize = true,
                Location = new Point(122, 15)
            };
            top.Controls.Add(title);
            top.Controls.Add(status);

            webView = new WebView2 { Dock = DockStyle.Fill };
            webView.DefaultBackgroundColor = Color.White;
            Controls.Add(webView);
            Controls.Add(top);

            Shown += async (s, e) => await InitializeAsync();
            FormClosed += (s, e) => { if (timer != null) { timer.Stop(); timer.Dispose(); } };
        }

        private async Task InitializeAsync()
        {
            try
            {
                CoreWebView2Environment env = sharedEnvironment;
                if (env == null)
                {
                    env = await CoreWebView2Environment.CreateAsync(null, System.IO.Path.Combine(dataDir, "WebView2"), null);
                }
                await webView.EnsureCoreWebView2Async(env);
                try
                {
                    uint dpi = GetDpiForWindow(webView.Handle);
                    if (dpi >= 96) webView.ZoomFactor = Math.Max(0.5, 96.0 / dpi);
                }
                catch { }
                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NavigationCompleted += async (s, e) => await CheckCookiesAsync();
                webView.CoreWebView2.NavigationStarting += (s, e) =>
                {
                    if (e.Uri != null && e.Uri.Contains("passport2.chaoxing.com"))
                    {
                        logged = false;
                        pushing = false;
                    }
                    lastUrl = e.Uri;
                };
                webView.CoreWebView2.Navigate("https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com");
                timer = new System.Windows.Forms.Timer { Interval = 2500 };
                timer.Tick += async (s, e) => await CheckCookiesAsync();
                timer.Start();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "无法打开学习通登录页：\n" + ex.Message, "课铃 ClassBell",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task CheckCookiesAsync()
        {
            if (pushing || logged || webView.CoreWebView2 == null) return;
            try
            {
                var cookies = await webView.CoreWebView2.CookieManager.GetCookiesAsync("https://i.chaoxing.com/");
                var uid = cookies.FirstOrDefault(c => c.Name == "_uid" || c.Name == "UID" || c.Name == "puid");
                if (uid == null || string.IsNullOrEmpty(uid.Value)) return;
                pushing = true;
                status.Text = "登录成功，正在同步作业…";
                status.ForeColor = Color.FromArgb(240, 206, 135);

                var list = new List<Dictionary<string, string>>();
                foreach (var cookie in cookies)
                {
                    list.Add(new Dictionary<string, string>
                    {
                        { "name", cookie.Name },
                        { "value", cookie.Value },
                        { "domain", cookie.Domain },
                        { "path", cookie.Path }
                    });
                }
                await HostApi.PostJsonAsync("/api/cx/cookies", new Dictionary<string, object> { { "cookies", list } });
                logged = true;
                status.Text = "已登录，正在同步作业…";
                status.ForeColor = Color.FromArgb(240, 206, 135);
                var syncText = await HostApi.PostJsonAsync("/api/cx/sync", new Dictionary<string, object>());
                var result = HostApi.ParseObject(syncText);
                bool ok = HostApi.Bool(result, "ok", false);
                string message = HostApi.Str(result, "message", ok ? "同步完成" : "同步失败");
                status.Text = ok ? "已登录 · " + message + "，可以关闭本窗口" : "已登录 · " + message;
                status.ForeColor = ok ? Color.FromArgb(185, 223, 198) : Color.FromArgb(255, 190, 170);
            }
            catch (Exception ex)
            {
                if (logged)
                {
                    status.Text = "已登录，但同步暂时失败：" + ex.Message;
                    status.ForeColor = Color.FromArgb(255, 190, 170);
                }
                else
                {
                    pushing = false;
                    status.Text = "登录状态读取失败：" + ex.Message;
                    status.ForeColor = Color.FromArgb(255, 190, 170);
                }
            }
        }
    }
}
