using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

// Tray launcher for the Twitch Emotes Bot: runs `node web-server.js` hidden,
// shows its state in the notification area and cleans up the whole process tree on exit.
// Build with tray\build.bat (uses the .NET Framework compiler that ships with Windows).
static class TrayApp
{
#if TESTBUILD
    // csc /define:TESTBUILD — отдельный экземпляр для проверок рядом с рабочим (своё имя и порт панели)
    const string AppName = "EmotesBotTray_Test";
    const int PanelPort = 3011;
#else
    const string AppName = "EmotesBotTray";
    const int PanelPort = 3001;
#endif
    const int OverlayPort = 3000;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    static string exeDir;  // папка с EmotesBotTray.exe
    static string baseDir; // папка с web-server.js (exeDir\app в релизе)
    static string logPath;
    static NotifyIcon tray;
    static Control ui; // для BeginInvoke в UI-поток
    static Process proc;
    static System.Windows.Forms.Timer pollTimer;
    static bool botRunning;
    static bool stopping;
    static Icon iconOn, iconOff, iconWait;
    static ToolStripMenuItem statusItem, autostartItem;
    static readonly object logLock = new object();

    [STAThread]
    static void Main()
    {
        bool createdNew;
        using (Mutex mutex = new Mutex(true, "Local\\" + AppName, out createdNew))
        {
            if (!createdNew) return;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Релиз: рядом с exe только папки app\ (бот) и runtime\ (node.exe).
            // В рабочей папке проекта всё лежит рядом с exe — тогда берём её саму.
            exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string appDir = Path.Combine(exeDir, "app");
            baseDir = File.Exists(Path.Combine(appDir, "web-server.js")) ? appDir : exeDir;
            logPath = Path.Combine(baseDir, "tray.log");

            iconOn = MakeIcon(Color.FromArgb(46, 204, 113));
            iconOff = MakeIcon(Color.FromArgb(150, 150, 150));
            iconWait = MakeIcon(Color.FromArgb(241, 196, 15));

            ui = new Control();
            IntPtr forceHandle = ui.Handle; // окно-маршалер: BeginInvoke из фоновых потоков работает и до первого показа меню

            BuildTray();
            ShowUpdateResult();
            StartupMigrationThenStart();

            pollTimer = new System.Windows.Forms.Timer();
            pollTimer.Interval = 3000;
            pollTimer.Tick += delegate { PollStatus(); };
            pollTimer.Start();

            Application.Run();
        }
    }

    static void BuildTray()
    {
        ContextMenuStrip menu = new ContextMenuStrip();

        statusItem = new ToolStripMenuItem("Запуск...");
        statusItem.Enabled = false;
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());

        menu.Items.Add("Открыть панель управления", null, delegate { OpenPanel(); });
        menu.Items.Add("Скопировать URL эмоутов", null, delegate { CopyUrl("emotes.html"); });
        menu.Items.Add("Скопировать URL приветствий", null, delegate { CopyUrl("greeting.html"); });
        menu.Items.Add("Скопировать URL текущей игры", null, delegate { CopyUrl("game.html"); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Перезапустить", null, delegate { RestartBackend(); });
        menu.Items.Add("Открыть лог", null, delegate { OpenLog(); });
        menu.Items.Add("Перенести данные из старой версии…", null, delegate { ImportFromMenu(); });

        autostartItem = new ToolStripMenuItem("Запускать вместе с Windows");
        autostartItem.Checked = IsAutostart();
        autostartItem.Click += delegate { ToggleAutostart(); };
        menu.Items.Add(autostartItem);

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Выход", null, delegate { Quit(); });

        tray = new NotifyIcon();
        tray.Icon = iconWait;
        tray.Text = "Twitch Emotes Bot";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate { OpenPanel(); };
    }

    // ---------- backend process ----------

    static void StartBackend()
    {
        stopping = false;
        botRunning = false;
        SetState(iconWait, "Запуск...");

        string script = Path.Combine(baseDir, "web-server.js");
        if (!File.Exists(script))
        {
            MessageBox.Show("Не найден web-server.js — ни в папке app, ни рядом с программой:\n" + exeDir,
                "Twitch Emotes Bot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            SetState(iconOff, "Ошибка: нет web-server.js");
            return;
        }

        // Prefer the bundled runtime\node.exe so Node.js doesn't need to be installed.
        string nodeExe = "node";
        foreach (string candidate in new[] { Path.Combine(exeDir, "runtime", "node.exe"), Path.Combine(baseDir, "runtime", "node.exe") })
        {
            if (File.Exists(candidate)) { nodeExe = candidate; break; }
        }

        ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "\"" + script + "\"");
        psi.WorkingDirectory = baseDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.EnvironmentVariables["NO_BROWSER"] = "1";
        psi.EnvironmentVariables["WEB_PORT"] = PanelPort.ToString();
        if (IsReleaseLayout())
        {
            // по этим переменным панель понимает, что может сама поставить обновление (updates.js -> updater.ps1)
            psi.EnvironmentVariables["TRAY_PID"] = Process.GetCurrentProcess().Id.ToString();
            psi.EnvironmentVariables["INSTALL_DIR"] = exeDir.TrimEnd('\\');
        }

        try
        {
            try { File.WriteAllText(logPath, "", Encoding.UTF8); } catch { }
            Process p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { AppendLog(e.Data); };
            p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { AppendLog(e.Data); };
            p.Exited += delegate
            {
                if (stopping) return;
                botRunning = false;
                AppendLog("[TRAY] web-server.js exited unexpectedly");
                SetStateAsync(iconOff, "Остановлен (процесс завершился)");
            };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            proc = p;
        }
        catch (Exception ex)
        {
            MessageBox.Show("Не удалось запустить Node.js (нет runtime\\node.exe и в PATH его тоже нет).\n\n" + ex.Message,
                "Twitch Emotes Bot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            SetState(iconOff, "Ошибка запуска Node.js");
        }
    }

    static void StopBackend()
    {
        stopping = true;
        Process p = proc;
        proc = null;
        if (p == null) return;

        // Ask the panel to stop the bot so it can save greetings, then kill whatever is left.
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + PanelPort + "/api/stop");
            req.Method = "POST";
            req.ContentLength = 0;
            req.Timeout = 4000;
            using (req.GetResponse()) { }
        }
        catch { }

        try
        {
            if (!p.HasExited)
            {
                ProcessStartInfo kill = new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F");
                kill.CreateNoWindow = true;
                kill.UseShellExecute = false;
                using (Process k = Process.Start(kill)) { k.WaitForExit(5000); }
            }
        }
        catch { }
    }

    static void RestartBackend()
    {
        SetState(iconWait, "Перезапуск...");
        ThreadPool.QueueUserWorkItem(delegate
        {
            StopBackend();
            Thread.Sleep(500);
            ui.BeginInvoke((MethodInvoker)delegate { StartBackend(); });
        });
    }

    static void Quit()
    {
        pollTimer.Stop();
        tray.Visible = false;
        StopBackend();
        tray.Dispose();
        Application.Exit();
    }

    // ---------- status ----------

    static void PollStatus()
    {
        if (stopping || proc == null) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            bool running = false;
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + PanelPort + "/api/status");
                req.Timeout = 2000;
                using (WebResponse resp = req.GetResponse())
                using (StreamReader r = new StreamReader(resp.GetResponseStream()))
                {
                    running = r.ReadToEnd().Replace(" ", "").Contains("\"running\":true");
                }
            }
            catch { }

            if (stopping) return;
            botRunning = running;
            if (running) SetStateAsync(iconOn, "Работает");
            else SetStateAsync(iconWait, "Запуск бота...");
        });
    }

    static void SetState(Icon icon, string text)
    {
        if (tray == null) return;
        tray.Icon = icon;
        tray.Text = Truncate("Emotes Bot: " + text, 63);
        statusItem.Text = text;
    }

    static void SetStateAsync(Icon icon, string text)
    {
        if (tray == null || ui == null) return;
        try { ui.BeginInvoke((MethodInvoker)delegate { SetState(icon, text); }); }
        catch { }
    }

    static string Truncate(string s, int max)
    {
        return s.Length <= max ? s : s.Substring(0, max);
    }

    // ---------- actions ----------

    static void OpenPanel()
    {
        try { Process.Start(new ProcessStartInfo("http://localhost:" + PanelPort) { UseShellExecute = true }); }
        catch { }
    }

    static void CopyUrl(string page)
    {
        try
        {
            Clipboard.SetText("http://127.0.0.1:" + OverlayPort + "/" + page);
            tray.ShowBalloonTip(1500, "Скопировано", "http://127.0.0.1:" + OverlayPort + "/" + page, ToolTipIcon.Info);
        }
        catch { }
    }

    static void OpenLog()
    {
        try
        {
            if (!File.Exists(logPath)) File.WriteAllText(logPath, "", Encoding.UTF8);
            Process.Start(new ProcessStartInfo(logPath) { UseShellExecute = true });
        }
        catch { }
    }

    static void AppendLog(string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            try
            {
                FileInfo fi = new FileInfo(logPath);
                if (fi.Exists && fi.Length > 5 * 1024 * 1024) File.WriteAllText(logPath, "", Encoding.UTF8);
                File.AppendAllText(logPath, line + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }
    }

    // ---------- после обновления ----------
    // updater.ps1 пишет итог в app\.update-result.json и запускает трей заново. Файл свежий — сообщаем,
    // сам файл не удаляем: его ещё покажет панель.
    static void ShowUpdateResult()
    {
        try
        {
            string file = Path.Combine(baseDir, ".update-result.json");
            if (!File.Exists(file) || (DateTime.Now - File.GetLastWriteTime(file)).TotalMinutes > 5) return;
            string json = File.ReadAllText(file);
            bool ok = json.Replace(" ", "").Contains("\"ok\":true");
            string to = JsonValue(json, "to");
            string error = JsonValue(json, "error");
            if (ok) tray.ShowBalloonTip(5000, "Emotes Bot обновлён", "Установлена версия " + to, ToolTipIcon.Info);
            else tray.ShowBalloonTip(8000, "Обновление не удалось", string.IsNullOrEmpty(error) ? "Подробности в панели" : error, ToolTipIcon.Warning);
        }
        catch { }
    }

    // Простейшее чтение строкового поля из маленького JSON (без зависимостей)
    static string JsonValue(string json, string key)
    {
        int i = json.IndexOf("\"" + key + "\"");
        if (i < 0) return "";
        i = json.IndexOf(':', i);
        if (i < 0) return "";
        int start = json.IndexOf('"', i);
        int nul = json.IndexOf("null", i);
        if (start < 0 || (nul >= 0 && nul < start)) return "";
        int end = json.IndexOf('"', start + 1);
        return end > start ? json.Substring(start + 1, end - start - 1) : "";
    }

    // ---------- переход со старой версии ----------
    // Старая версия: всё в одной папке (start.bat, server.js, bot-config.json, cache, sounds...).
    // В релизе данные живут в app\. Переносим настройки, кэш эмоутов, приветствия и звуки.

    // Файлы старой версии, которые убираем из корня при обновлении «поверх». Чужие файлы не трогаем.
    static readonly string[] LegacyItems = {
        "server.js", "web-server.js", "start.bat", "dependencies.bat", "package.json", "package-lock.json",
        "node_modules", "overlay", "web-gui", "scripts", "special-sounds-packed.json", "bot-config.json",
        "bot-config.example.json", ".env", ".env.example", ".gitignore", "README.md", ".vs",
        "cache", "greetings", "sounds", "tray.log"
    };

    class MigrationResult
    {
        public bool Config;
        public int Cache, Greetings, Sounds, Failed, MovedAway;
        public string Error;
    }

    static bool IsReleaseLayout()
    {
        return !string.Equals(Path.GetFullPath(baseDir).TrimEnd('\\'), Path.GetFullPath(exeDir).TrimEnd('\\'),
            StringComparison.OrdinalIgnoreCase);
    }

    static bool LooksLikeOldVersion(string dir)
    {
        return File.Exists(Path.Combine(dir, "bot-config.json")) || File.Exists(Path.Combine(dir, "server.js"));
    }

    static string ImportAskedFlag()
    {
        return Path.Combine(baseDir, ".import-asked");
    }

    static void StartupMigrationThenStart()
    {
        if (!IsReleaseLayout()) { StartBackend(); return; } // рабочая папка проекта — переносить нечего

        // 1) новую версию распаковали поверх старой: старые файлы лежат рядом с exe
        if (File.Exists(Path.Combine(exeDir, "server.js")) || File.Exists(Path.Combine(exeDir, "start.bat")))
        {
            DialogResult answer = MessageBox.Show(
                "В этой папке лежит старая версия бота.\n\n" +
                "Перенести настройки, звуки, приветствия и кэш эмоутов в новую версию?\n" +
                "Старые файлы программы будут убраны в папку old_version — её потом можно удалить.",
                "Twitch Emotes Bot — обновление", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer == DialogResult.Yes) { RunMigration(exeDir, true, true, true); return; }
        }
        // 2) первый запуск новой версии (настроек ещё нет) — предложить взять их из папки старой версии
        else if (!File.Exists(Path.Combine(baseDir, "bot-config.json")) && !File.Exists(ImportAskedFlag()))
        {
            try { File.WriteAllText(ImportAskedFlag(), DateTime.Now.ToString("s")); } catch { }
            DialogResult answer = MessageBox.Show(
                "Это первый запуск новой версии.\n\n" +
                "Если у вас была старая версия бота, из неё можно перенести настройки, звуки, приветствия и кэш эмоутов. " +
                "Выбрать папку старой версии?\n\n(Позже это можно сделать из меню иконки в трее.)",
                "Twitch Emotes Bot", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer == DialogResult.Yes)
            {
                string dir = PickOldVersionFolder();
                if (dir != null) { RunMigration(dir, false, true, false); return; }
            }
        }
        StartBackend();
    }

    static string PickOldVersionFolder()
    {
        using (FolderBrowserDialog dlg = new FolderBrowserDialog())
        {
            dlg.Description = "Папка старой версии бота (там лежат start.bat и bot-config.json)";
            dlg.ShowNewFolderButton = false;
            try { dlg.SelectedPath = Directory.GetParent(exeDir.TrimEnd('\\')).FullName; } catch { }
            while (dlg.ShowDialog() == DialogResult.OK)
            {
                string dir = dlg.SelectedPath;
                bool isSelf = string.Equals(Path.GetFullPath(dir).TrimEnd('\\'), Path.GetFullPath(baseDir).TrimEnd('\\'),
                    StringComparison.OrdinalIgnoreCase);
                if (!isSelf && LooksLikeOldVersion(dir)) return dir;
                MessageBox.Show(isSelf
                        ? "Это папка новой версии. Выберите папку, где лежит старая."
                        : "В этой папке нет старой версии бота (не найдены bot-config.json или server.js). Выберите другую.",
                    "Twitch Emotes Bot", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        return null;
    }

    static void ImportFromMenu()
    {
        if (!IsReleaseLayout())
        {
            MessageBox.Show("Перенос данных нужен только для готовой версии (с папкой app рядом с программой).",
                "Twitch Emotes Bot", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        string dir = PickOldVersionFolder();
        if (dir == null) return;

        bool overwriteConfig = true;
        if (File.Exists(Path.Combine(baseDir, "bot-config.json")))
        {
            DialogResult a = MessageBox.Show(
                "Заменить текущие настройки настройками из старой версии?\n\n" +
                "Да — заменить (текущие сохранятся в bot-config.json.bak)\n" +
                "Нет — оставить текущие, перенести только звуки, приветствия и кэш",
                "Twitch Emotes Bot", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (a == DialogResult.Cancel) return;
            overwriteConfig = a == DialogResult.Yes;
        }
        RunMigration(dir, false, overwriteConfig, false);
    }

    // Перенос идёт в фоне (кэш эмоутов — сотни мегабайт), потом бот запускается заново
    static void RunMigration(string oldDir, bool move, bool overwriteConfig, bool cleanupRoot)
    {
        SetState(iconWait, "Перенос данных...");
        tray.ShowBalloonTip(3000, "Перенос данных", "Переношу настройки, звуки и кэш из старой версии…", ToolTipIcon.Info);
        ThreadPool.QueueUserWorkItem(delegate
        {
            if (proc != null) StopBackend(); // бот не должен держать файлы во время переноса
            MigrationResult r = Migrate(oldDir, move, overwriteConfig);
            if (cleanupRoot) r.MovedAway = MoveLegacyToOldVersion();
            ui.BeginInvoke((MethodInvoker)delegate
            {
                ShowMigrationResult(r, cleanupRoot);
                StartBackend();
            });
        });
    }

    static MigrationResult Migrate(string oldDir, bool move, bool overwriteConfig)
    {
        MigrationResult r = new MigrationResult();
        try
        {
            string src = Path.Combine(oldDir, "bot-config.json");
            string dst = Path.Combine(baseDir, "bot-config.json");
            if (File.Exists(src) && (overwriteConfig || !File.Exists(dst)))
            {
                if (File.Exists(dst)) File.Copy(dst, dst + ".bak", true);
                File.Copy(src, dst, true); // формат старого конфига совместим, новые настройки получат значения по умолчанию
                r.Config = true;
            }
            r.Cache = MergeDir(Path.Combine(oldDir, "cache"), Path.Combine(baseDir, "cache"), move, r);
            r.Greetings = MergeDir(Path.Combine(oldDir, "greetings"), Path.Combine(baseDir, "greetings"), move, r);
            r.Sounds = MergeDir(Path.Combine(oldDir, "sounds"), Path.Combine(baseDir, "sounds"), move, r);
        }
        catch (Exception ex)
        {
            r.Error = ex.Message;
        }
        return r;
    }

    // Копирует (или переносит) файлы из src в dst с сохранением подпапок. Существующие файлы не перезаписывает.
    static int MergeDir(string src, string dst, bool move, MigrationResult r)
    {
        if (!Directory.Exists(src)) return 0;
        int count = 0;
        string root = Path.GetFullPath(src).TrimEnd('\\') + "\\";
        foreach (string file in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
        {
            try
            {
                string target = Path.Combine(dst, Path.GetFullPath(file).Substring(root.Length));
                if (File.Exists(target)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                if (move) File.Move(file, target);
                else File.Copy(file, target);
                count++;
            }
            catch
            {
                r.Failed++;
            }
        }
        return count;
    }

    // После обновления «поверх» убираем файлы старой версии из корня в old_version
    static int MoveLegacyToOldVersion()
    {
        string dest = Path.Combine(exeDir, "old_version");
        int moved = 0;
        foreach (string name in LegacyItems)
        {
            string path = Path.Combine(exeDir, name);
            try
            {
                bool isDir = Directory.Exists(path);
                if (!isDir && !File.Exists(path)) continue;
                Directory.CreateDirectory(dest);
                string target = Path.Combine(dest, name);
                if (File.Exists(target) || Directory.Exists(target)) target += "_" + DateTime.Now.ToString("yyyyMMdd_HHmmss");
                if (isDir) Directory.Move(path, target);
                else File.Move(path, target);
                moved++;
            }
            catch { }
        }
        return moved;
    }

    static void ShowMigrationResult(MigrationResult r, bool cleanupRoot)
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine(r.Error == null ? "Готово! Перенесено из старой версии:" : "Перенос прерван: " + r.Error);
        sb.AppendLine();
        sb.AppendLine("Настройки: " + (r.Config ? "перенесены" : "оставлены текущие"));
        sb.AppendLine("Звуки: " + r.Sounds + " файлов");
        sb.AppendLine("Кэш эмоутов: " + r.Cache + " файлов");
        sb.AppendLine("Приветствия: " + r.Greetings + " файлов");
        if (r.Failed > 0) sb.AppendLine("\nНе удалось перенести файлов: " + r.Failed + " (возможно, они открыты в другой программе)");
        if (cleanupRoot && r.MovedAway > 0) sb.AppendLine("\nСтарые файлы программы убраны в папку old_version — её можно удалить.");
        sb.AppendLine("\nСсылки для OBS не изменились.");
        MessageBox.Show(sb.ToString(), "Twitch Emotes Bot — обновление", MessageBoxButtons.OK,
            r.Error == null ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
    }

    // ---------- autostart ----------

    static bool IsAutostart()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
                return k != null && k.GetValue(AppName) != null;
        }
        catch { return false; }
    }

    static void ToggleAutostart()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                if (autostartItem.Checked) k.DeleteValue(AppName, false);
                else k.SetValue(AppName, "\"" + Application.ExecutablePath + "\"");
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Автозапуск", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        autostartItem.Checked = IsAutostart();
    }

    // ---------- icon ----------

    static Icon MakeIcon(Color fill)
    {
        using (Bitmap bmp = new Bitmap(32, 32))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (Brush b = new SolidBrush(fill)) g.FillEllipse(b, 1, 1, 29, 29);
                using (Pen p = new Pen(Color.FromArgb(60, 0, 0, 0), 2)) g.DrawEllipse(p, 1, 1, 29, 29);
                g.FillEllipse(Brushes.White, 9, 9, 5, 6);
                g.FillEllipse(Brushes.White, 18, 9, 5, 6);
                using (Pen smile = new Pen(Color.White, 2.5f)) g.DrawArc(smile, 8, 11, 16, 12, 20, 140);
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }
}
