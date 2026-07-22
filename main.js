const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, moment, SecretComponent } = require('obsidian');

const LEGACY_SECRET_ID = 'todoist-daily-archive-token';

const DEFAULT_SETTINGS = {
  // Enthält nur den NAMEN des Secrets in der Obsidian-Keychain, nie den Tokenwert selbst.
  apiTokenSecretId: '',
  headingLevel: 2,
  headingText: 'Erledigt (Todoist)',
  projectFilter: '',
  taskTemplate: '- [x] [{content}]({url}){project} (erledigt {date})',
  dedupe: true,
  dailyNoteFormatOverride: '',
};

// Frühere Default-Vorlage ohne Link, um unveränderte Installationen behutsam zu migrieren.
const OLD_DEFAULT_TASK_TEMPLATE = '- [x] {content}{project} (erledigt {date})';

const API_BASE = 'https://api.todoist.com/api/v1';

module.exports = class TodoistArchivePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new TodoistArchiveSettingTab(this.app, this));

    this.addCommand({
      id: 'archive-completed-todoist-tasks-current-note',
      name: 'Erledigte Todoist-Tasks in aktuelle Daily Note archivieren',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.archiveForFile(file);
        return true;
      },
    });

    this.addCommand({
      id: 'archive-completed-todoist-tasks-yesterday',
      name: "Erledigte Todoist-Tasks von gestern in gestriges Daily Note archivieren",
      callback: () => this.archiveForRelativeDay(-1),
    });

    this.addCommand({
      id: 'todoist-daily-archive-diagnose',
      name: 'Diagnose: erkanntes Daily-Note-Format anzeigen',
      callback: () => {
        const { format, folder, source } = this.getDailyNoteInfo();
        const file = this.app.workspace.getActiveFile();
        const basename = file ? file.basename : '(keine Datei geöffnet)';
        const parses = file ? !!this.getDateFromFile(file) : false;
        new Notice(
          `Quelle: ${source}\n` +
          `Format: "${format}"\n` +
          `Ordner: "${folder || '(Vault-Root)'}"\n` +
          `Aktuelle Datei: "${basename}"\n` +
          `Passt zum Format: ${parses ? 'Ja' : 'Nein'}`,
          15000
        );
      },
    });
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Migration: ältere Plugin-Version hat das Token als Klartext in data.json abgelegt.
    if (data.apiToken && !this.settings.apiTokenSecretId) {
      await this.migrateLegacyPlaintextToken(data.apiToken);
    }

    // Migration: ältere Plugin-Version hatte ein einzelnes "heading"-Feld inkl. #-Präfix.
    if (data.heading && !data.headingText) {
      const m = /^(#{1,6})\s*(.*)$/.exec(data.heading.trim());
      if (m) {
        this.settings.headingLevel = m[1].length;
        this.settings.headingText = m[2].trim();
      } else {
        this.settings.headingText = data.heading.trim();
      }
      delete this.settings.heading;
      await this.saveSettings();
    }

    // Sanfte Migration: nur wenn die Zeilen-Vorlage noch exakt dem alten,
    // linklosen Standard entspricht (also unverändert), auf die neue
    // Standard-Vorlage mit {url}-Link anheben. Individuell angepasste
    // Vorlagen werden nicht angefasst.
    if (data.taskTemplate === OLD_DEFAULT_TASK_TEMPLATE) {
      this.settings.taskTemplate = DEFAULT_SETTINGS.taskTemplate;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  hasSecretStorage() {
    return !!(this.app.secretStorage && typeof this.app.secretStorage.getSecret === 'function');
  }

  async migrateLegacyPlaintextToken(plaintextToken) {
    if (!this.hasSecretStorage()) {
      new Notice(
        'Ein altes, unverschlüsselt gespeichertes Todoist-Token wurde gefunden, kann aber erst migriert ' +
        'werden, sobald Obsidian auf mindestens 1.11.4 aktualisiert ist (Keychain/SecretStorage-API).'
      );
      return;
    }
    try {
      this.app.secretStorage.setSecret(LEGACY_SECRET_ID, plaintextToken);
      this.settings.apiTokenSecretId = LEGACY_SECRET_ID;
      delete this.settings.apiToken;
      await this.saveSettings();
      new Notice('Todoist-Token wurde in die Obsidian-Keychain verschoben und aus data.json entfernt.');
    } catch (e) {
      console.error('Todoist Daily Archive: Migration des Tokens fehlgeschlagen.', e);
      new Notice('Migration des Todoist-Tokens in die Keychain ist fehlgeschlagen, siehe Konsole.');
    }
  }

  // Liest den eigentlichen Tokenwert zur Laufzeit aus der Keychain. Wird nie in this.settings abgelegt.
  getApiToken() {
    if (!this.settings.apiTokenSecretId) return null;
    if (!this.hasSecretStorage()) return null;
    return this.app.secretStorage.getSecret(this.settings.apiTokenSecretId) || null;
  }

  // --- Daily-Note-Format ermitteln (Core-Plugin oder Periodic Notes) ---
  getDailyNoteInfo() {
    if (this.settings.dailyNoteFormatOverride.trim()) {
      return { format: this.settings.dailyNoteFormatOverride.trim(), folder: '', source: 'Override (Einstellungen)' };
    }
    const core = this.app.internalPlugins && this.app.internalPlugins.plugins['daily-notes'];
    if (core && core.enabled && core.instance && core.instance.options) {
      const opts = core.instance.options;
      // Core-Plugin liefert nur Werte für Felder, die vom Nutzer explizit gesetzt wurden;
      // fehlende Felder heißen NICHT "nicht konfiguriert", sondern "Standardwert".
      return {
        format: opts.format || 'YYYY-MM-DD',
        folder: opts.folder || '',
        source: 'Core-Plugin "Tägliche Notiz"',
      };
    }
    const periodic = this.app.plugins && this.app.plugins.plugins['periodic-notes'];
    // Hinweis: "enabled"-Flag existiert nicht in jeder Periodic-Notes-Version pro Intervall;
    // wir werten daher schon die bloße Existenz von settings.daily als "konfiguriert".
    if (periodic && periodic.settings && periodic.settings.daily) {
      return {
        format: periodic.settings.daily.format || 'YYYY-MM-DD',
        folder: periodic.settings.daily.folder || '',
        source: 'Community-Plugin "Periodic Notes"',
      };
    }
    return { format: 'YYYY-MM-DD', folder: '', source: 'Standardwert (kein Daily-Notes-Plugin erkannt)' };
  }

  getDateFromFile(file) {
    const { format, source } = this.getDailyNoteInfo();
    let m = moment(file.basename, format, true);
    if (!m.isValid()) {
      // Zweiter Versuch ohne strikten Modus, aber nur akzeptiert, wenn das
      // Ergebnis beim Zurückformatieren exakt wieder den Dateinamen ergibt
      // (verhindert falsch-positive Treffer wie "Meeting-Notizen-2026").
      const loose = moment(file.basename, format, false);
      if (loose.isValid() && loose.format(format) === file.basename) {
        m = loose;
      }
    }
    if (!m.isValid()) {
      console.warn(
        `Todoist Daily Archive: Dateiname "${file.basename}" passt nicht zum erkannten Format ` +
        `"${format}" (Quelle: ${source}). Ggf. unter Einstellungen -> Todoist Daily Archive das ` +
        `Datumsformat manuell überschreiben.`
      );
      return null;
    }
    return m;
  }

  async findDailyNoteForDate(m) {
    const { format, folder } = this.getDailyNoteInfo();
    const filename = m.format(format) + '.md';
    const path = folder ? `${folder.replace(/\/$/, '')}/${filename}` : filename;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) return existing;
    // Fallback: irgendwo im Vault nach Datei mit passendem Basename suchen
    const base = m.format(format);
    const files = this.app.vault.getMarkdownFiles();
    return files.find((f) => f.basename === base) || null;
  }

  async archiveForRelativeDay(offsetDays) {
    if (!this.hasSecretStorage()) {
      new Notice('Diese Obsidian-Version unterstützt die Keychain (SecretStorage) noch nicht. Bitte auf mindestens 1.11.4 aktualisieren.');
      return;
    }
    if (!this.getApiToken()) {
      new Notice('Kein Todoist API Token hinterlegt (Einstellungen -> Todoist Daily Archive).');
      return;
    }
    const date = moment().add(offsetDays, 'days');
    const file = await this.findDailyNoteForDate(date);
    if (!file) {
      new Notice(`Keine Daily Note für ${date.format('DD.MM.YYYY')} gefunden.`);
      return;
    }
    await this.runArchive(file, date);
  }

  async archiveForFile(file) {
    if (!this.hasSecretStorage()) {
      new Notice('Diese Obsidian-Version unterstützt die Keychain (SecretStorage) noch nicht. Bitte auf mindestens 1.11.4 aktualisieren.');
      return;
    }
    if (!this.getApiToken()) {
      new Notice('Kein Todoist API Token hinterlegt (Einstellungen -> Todoist Daily Archive).');
      return;
    }
    const date = this.getDateFromFile(file);
    if (!date) {
      const { format, source } = this.getDailyNoteInfo();
      new Notice(
        `Diese Datei sieht nicht wie eine Daily Note aus.\n` +
        `Erkanntes Format: "${format}" (Quelle: ${source})\n` +
        `Dateiname: "${file.basename}"\n` +
        `Details auch in der Entwicklerkonsole (Strg/Cmd+Shift+I).`,
        10000
      );
      return;
    }
    await this.runArchive(file, date);
  }

  async runArchive(file, date) {
    const since = date.clone().startOf('day').utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
    const until = date.clone().endOf('day').utc().format('YYYY-MM-DDTHH:mm:ss[Z]');

    new Notice('Lade erledigte Todoist-Tasks ...');
    let tasks;
    try {
      tasks = await this.fetchCompletedTasks(since, until);
    } catch (e) {
      console.error('Todoist Daily Archive:', e);
      new Notice('Fehler beim Abruf der Todoist-API: ' + e.message);
      return;
    }

    if (this.settings.projectFilter.trim()) {
      const wanted = this.settings.projectFilter
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      tasks = tasks.filter((t) => wanted.includes((t.projectName || '').toLowerCase()));
    }

    if (tasks.length === 0) {
      new Notice(`Keine erledigten Tasks für ${date.format('DD.MM.YYYY')} gefunden.`);
      return;
    }

    const inserted = await this.insertIntoNote(file, tasks);
    if (inserted === 0) {
      new Notice('Alle gefundenen Tasks waren bereits archiviert.');
    } else {
      new Notice(`${inserted} Task(s) in "${file.basename}" archiviert.`);
    }
  }

  async fetchCompletedTasks(since, until) {
    const token = this.getApiToken();
    if (!token) throw new Error('Kein Todoist API Token in der Keychain gefunden.');
    let cursor = null;
    const all = [];

    do {
      const params = new URLSearchParams({ since, until, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const url = `${API_BASE}/tasks/completed/by_completion_date?${params.toString()}`;
      const res = await requestUrl({
        url,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} beim Laden erledigter Tasks: ${(res.text || '').slice(0, 200)}`);
      }
      const data = res.json || {};
      const items = data.items || data.results || [];
      all.push(...items);
      cursor = data.next_cursor || null;
    } while (cursor);

    const projectIds = [...new Set(all.map((t) => t.project_id).filter(Boolean))];
    if (projectIds.length) {
      try {
        const projMap = await this.fetchProjectNames();
        all.forEach((t) => {
          t.projectName = projMap[t.project_id] || '';
        });
      } catch (e) {
        console.warn('Todoist Daily Archive: Projektnamen konnten nicht geladen werden.', e);
      }
    }

    return all;
  }

  async fetchProjectNames() {
    const token = this.getApiToken();
    if (!token) return {};
    const map = {};
    let cursor = null;

    do {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      const url = `${API_BASE}/projects${params.toString() ? '?' + params.toString() : ''}`;
      const res = await requestUrl({
        url,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      if (res.status < 200 || res.status >= 300) return map;
      const data = res.json || {};
      const list = data.results || data.projects || (Array.isArray(data) ? data : []);
      (list || []).forEach((p) => {
        map[p.id] = p.name;
      });
      cursor = data.next_cursor || null;
    } while (cursor);

    return map;
  }

  buildLine(task) {
    // content darf in Markdown-Linktexten keine ungepaarten [ ] enthalten, sonst bricht der Link.
    const rawContent = (task.content || '').trim();
    const content = rawContent.split('[').join('\\[').split(']').join('\\]');
    const project = task.projectName ? ` (${task.projectName})` : '';
    const date = task.completed_at ? moment(task.completed_at).format('DD.MM.YYYY HH:mm') : '';
    // Todoist liefert pro Task ein "url"-Feld; falls das mal fehlen sollte,
    // auf das aktuelle Web-App-Schema zurückfallen.
    const url = task.url || `https://app.todoist.com/app/task/${task.id}`;
    const line = this.settings.taskTemplate
      .split('{content}').join(content)
      .split('{project}').join(project)
      .split('{date}').join(date)
      .split('{url}').join(url);
    return this.settings.dedupe ? `${line} <!--todoist-id:${task.id}-->` : line;
  }

  buildHeadingLine() {
    return '#'.repeat(this.settings.headingLevel) + ' ' + this.settings.headingText.trim();
  }

  // Findet eine ATX-Überschrift (#, ##, ...), auch wenn sie innerhalb eines
  // Blockquotes bzw. Callouts steht (Zeilen mit führendem ">" bzw. "> > ...").
  // Liefert Ebene, Text und den exakten Blockquote-Präfix (leer, falls keiner).
  // Prüft, ob eine Zeile als "Leerzeile" direkt unter einer Überschrift zählt.
  // Innerhalb eines Callouts/Blockquotes muss die Zeile trotzdem den ">"-Präfix
  // tragen (sonst wäre der Callout an der Stelle bereits zu Ende), sonst darf
  // sie nach Entfernen eines eventuellen Präfixes schlicht leer sein.
  isBlankSeparatorLine(line, requireQuotePrefix) {
    if (line === undefined) return false;
    const quoteMatch = /^((?:>\s?)*)/.exec(line);
    const prefix = quoteMatch ? quoteMatch[1] : '';
    const rest = line.slice(prefix.length);
    if (requireQuotePrefix && prefix.length === 0) return false;
    return rest.trim() === '';
  }

  parseHeadingLine(line) {
    const quoteMatch = /^((?:>\s?)+)/.exec(line);
    const prefix = quoteMatch ? quoteMatch[1] : '';
    const rest = line.slice(prefix.length);
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(rest);
    if (!m) return null;
    return { level: m[1].length, text: m[2].trim(), prefix };
  }

  async insertIntoNote(file, tasks) {
    const rawContent = await this.app.vault.read(file);
    const trailingNewline = rawContent.endsWith('\n');
    const lines = rawContent.split('\n');

    const existingIds = new Set();
    if (this.settings.dedupe) {
      const re = /<!--todoist-id:(\d+)-->/g;
      let m;
      while ((m = re.exec(rawContent))) existingIds.add(m[1]);
    }

    const toInsert = this.settings.dedupe
      ? tasks.filter((t) => !existingIds.has(String(t.id)))
      : tasks;

    if (toInsert.length === 0) return 0;

    const newLines = toInsert.map((t) => this.buildLine(t));
    const targetLevel = this.settings.headingLevel;
    const targetText = this.settings.headingText.trim();

    // Vorhandene Überschrift exakt gleicher Ebene und exakt gleichen Texts suchen
    // (auch innerhalb eines Callouts/Blockquotes).
    let headingIdx = -1;
    let headingPrefix = '';
    for (let i = 0; i < lines.length; i++) {
      const parsed = this.parseHeadingLine(lines[i]);
      if (parsed && parsed.level === targetLevel && parsed.text === targetText) {
        headingIdx = i;
        headingPrefix = parsed.prefix;
        break;
      }
    }

    if (headingIdx === -1) {
      // Überschrift existiert nicht: am Ende der Datei neu anlegen, mit
      // Leerzeile zwischen Überschrift und den archivierten Tasks.
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(this.buildHeadingLine());
      lines.push('');
      lines.push(...newLines);
    } else {
      // Direkt unter der Überschrift muss eine Leerzeile stehen (innerhalb
      // eines Callouts: eine Zeile mit demselben ">"-Präfix, aber ohne
      // Inhalt). Fehlt sie, wird sie einmalig eingefügt; ist sie schon da,
      // bleibt alles unverändert (kein Aufsummieren bei mehrfachem Archivieren).
      if (!this.isBlankSeparatorLine(lines[headingIdx + 1], !!headingPrefix)) {
        const separator = headingPrefix ? headingPrefix.trimEnd() : '';
        lines.splice(headingIdx + 1, 0, separator);
      }

      // Ende des Abschnitts bestimmen: nächste Überschrift mit gleicher oder höherer
      // Rangstufe (also gleich viele oder weniger #). Bis dahin wird am Abschnittsende
      // eingefügt, sodass mehrfaches Archivieren die Reihenfolge nicht durcheinanderwirft.
      // Steht die Überschrift in einem Callout, endet der Abschnitt zusätzlich spätestens
      // dort, wo der Blockquote selbst endet (erste Zeile ohne führendes ">").
      let sectionEnd = lines.length;
      for (let i = headingIdx + 1; i < lines.length; i++) {
        const parsed = this.parseHeadingLine(lines[i]);
        if (parsed && parsed.level <= targetLevel) {
          sectionEnd = i;
          break;
        }
        if (headingPrefix && !/^>/.test(lines[i])) {
          sectionEnd = i;
          break;
        }
      }
      // Trailing Leerzeilen am Abschnittsende überspringen, damit die neuen Zeilen
      // direkt unter dem letzten vorhandenen Inhalt landen statt nach einer Lücke.
      // Darf nicht bis vor die Pflicht-Leerzeile direkt unter der Überschrift zurücklaufen.
      let insertAt = sectionEnd;
      while (insertAt > headingIdx + 2 && lines[insertAt - 1].trim() === '') insertAt--;

      // Steht die Überschrift in einem Callout/Blockquote, müssen die neuen Zeilen
      // denselben ">"-Präfix bekommen, sonst fallen sie optisch aus dem Callout heraus.
      const linesToInsert = headingPrefix ? newLines.map((l) => headingPrefix + l) : newLines;

      lines.splice(insertAt, 0, ...linesToInsert);
    }

    let newContent = lines.join('\n');
    if (trailingNewline && !newContent.endsWith('\n')) newContent += '\n';

    await this.app.vault.modify(file, newContent);
    return newLines.length;
  }
};

class TodoistArchiveSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Todoist Daily Archive' });

    if (this.plugin.hasSecretStorage()) {
      new Setting(containerEl)
        .setName('Todoist API Token')
        .setDesc(
          'Persönliches Token aus Todoist: Einstellungen -> Integrationen -> Entwickler. ' +
          'Wird über die Obsidian-Keychain (SecretStorage) gespeichert, nicht in data.json - ' +
          'so bleibt es aus synchronisierten Vault-Dateien draußen. In den Plugin-Einstellungen ' +
          'wird nur der Name des Secrets abgelegt, nicht der Tokenwert selbst.'
        )
        .addComponent((el) =>
          new SecretComponent(this.app, el)
            .setValue(this.plugin.settings.apiTokenSecretId)
            .onChange(async (value) => {
              this.plugin.settings.apiTokenSecretId = value;
              await this.plugin.saveSettings();
            })
        );
    } else {
      new Setting(containerEl)
        .setName('Todoist API Token')
        .setDesc(
          'Die Keychain (SecretStorage) steht erst ab Obsidian 1.11.4 zur Verfügung. ' +
          'Bitte Obsidian aktualisieren - aus Sicherheitsgründen bietet dieses Plugin bewusst ' +
          'keine Klartext-Eingabe als Fallback an.'
        );
    }

    new Setting(containerEl)
      .setName('Überschriftsebene')
      .setDesc('Hierarchie-Ebene der Überschrift, unter der archiviert wird (# bis ######).')
      .addDropdown((dropdown) => {
        for (let level = 1; level <= 6; level++) {
          dropdown.addOption(String(level), '#'.repeat(level) + ` (Ebene ${level})`);
        }
        dropdown.setValue(String(this.plugin.settings.headingLevel)).onChange(async (value) => {
          this.plugin.settings.headingLevel = parseInt(value, 10);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Überschriftstext')
      .setDesc(
        'Text der Überschrift, unter der Tasks eingefügt werden (ohne #). Existiert eine ' +
        'Überschrift mit exakt diesem Text auf der konfigurierten Ebene bereits, wird an deren ' +
        'Abschnittsende angehängt (bis zur nächsten gleich- oder höherrangigen Überschrift). ' +
        'Existiert sie nicht, wird sie am Dateiende neu angelegt.'
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.headingText)
          .onChange(async (value) => {
            this.plugin.settings.headingText = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Projekt-Filter (optional)')
      .setDesc('Kommagetrennte Liste von Todoist-Projektnamen. Leer = alle Projekte.')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.projectFilter)
          .onChange(async (value) => {
            this.plugin.settings.projectFilter = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Zeilen-Vorlage')
      .setDesc('Platzhalter: {content}, {project}, {date}, {url} (Link zum Task in Todoist)')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.taskTemplate)
          .onChange(async (value) => {
            this.plugin.settings.taskTemplate = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Duplikate vermeiden')
      .setDesc('Bereits archivierte Tasks (per versteckter ID-Markierung im Text) nicht erneut einfügen.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dedupe).onChange(async (value) => {
          this.plugin.settings.dedupe = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Daily-Note-Datumsformat überschreiben (optional)')
      .setDesc(
        'Nur setzen, wenn weder das Core-Plugin "Tägliche Notiz" noch "Periodic Notes" aktiv/erkennbar ist. ' +
        'Moment.js-Format, z.B. YYYY-MM-DD.'
      )
      .addText((text) =>
        text
          .setPlaceholder('z.B. YYYY-MM-DD')
          .setValue(this.plugin.settings.dailyNoteFormatOverride)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteFormatOverride = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
