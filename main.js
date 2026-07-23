const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, moment, SecretComponent } = require('obsidian');

const LEGACY_SECRET_ID = 'todoist-daily-archive-token';

const DEFAULT_SETTINGS = {
  // Only holds the NAME of the secret in the Obsidian keychain, never the token value itself.
  apiTokenSecretId: '',
  headingLevel: 2,
  headingText: 'Completed (Todoist)',
  projectFilter: '',
  taskTemplate: '- [x] [{content}]({url}){project} (completed {date})',
  dedupe: true,
  dailyNoteFormatOverride: '',
};

// Previous default template without a link, used to gently migrate untouched installs.
const OLD_DEFAULT_TASK_TEMPLATE = '- [x] {content}{project} (completed {date})';
// Even older, German-language default template from earlier plugin versions.
const OLD_DEFAULT_TASK_TEMPLATE_DE = '- [x] {content}{project} (erledigt {date})';

const API_BASE = 'https://api.todoist.com/api/v1';

module.exports = class TodoistArchivePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new TodoistArchiveSettingTab(this.app, this));

    this.addCommand({
      id: 'archive-completed-todoist-tasks-current-note',
      name: 'Archive completed Todoist tasks into current daily note',
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
      name: "Archive yesterday's completed Todoist tasks into yesterday's daily note",
      callback: () => this.archiveForRelativeDay(-1),
    });

    this.addCommand({
      id: 'todoist-daily-archive-diagnose',
      name: 'Diagnose: show detected daily note format',
      callback: () => {
        const { format, folder, source } = this.getDailyNoteInfo();
        const file = this.app.workspace.getActiveFile();
        const basename = file ? file.basename : '(no file open)';
        const parses = file ? !!this.getDateFromFile(file) : false;
        new Notice(
          `Source: ${source}\n` +
          `Format: "${format}"\n` +
          `Folder: "${folder || '(vault root)'}"\n` +
          `Current file: "${basename}"\n` +
          `Matches format: ${parses ? 'Yes' : 'No'}`,
          15000
        );
      },
    });
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Migration: an older plugin version stored the token as plaintext in data.json.
    if (data.apiToken && !this.settings.apiTokenSecretId) {
      await this.migrateLegacyPlaintextToken(data.apiToken);
    }

    // Migration: an older plugin version had a single "heading" field including the # prefix.
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

    // Gentle migration: only upgrade the task line template to the new default
    // (with an {url} link) if it still exactly matches an older, unmodified
    // default (German or English wording). Custom templates are left untouched.
    if (
      data.taskTemplate === OLD_DEFAULT_TASK_TEMPLATE ||
      data.taskTemplate === OLD_DEFAULT_TASK_TEMPLATE_DE
    ) {
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
        'Found an old, unencrypted Todoist token, but it can only be migrated once Obsidian is ' +
        'updated to at least 1.11.4 (Keychain / SecretStorage API).'
      );
      return;
    }
    try {
      this.app.secretStorage.setSecret(LEGACY_SECRET_ID, plaintextToken);
      this.settings.apiTokenSecretId = LEGACY_SECRET_ID;
      delete this.settings.apiToken;
      await this.saveSettings();
      new Notice('Todoist token was moved into the Obsidian keychain and removed from data.json.');
    } catch (e) {
      console.error('Todoist Daily Archive: token migration failed.', e);
      new Notice('Migrating the Todoist token into the keychain failed, see console for details.');
    }
  }

  // Reads the actual token value at runtime from the keychain. Never stored on this.settings.
  getApiToken() {
    if (!this.settings.apiTokenSecretId) return null;
    if (!this.hasSecretStorage()) return null;
    return this.app.secretStorage.getSecret(this.settings.apiTokenSecretId) || null;
  }

  // --- Determine daily note format (core plugin or Periodic Notes) ---
  getDailyNoteInfo() {
    if (this.settings.dailyNoteFormatOverride.trim()) {
      return { format: this.settings.dailyNoteFormatOverride.trim(), folder: '', source: 'Override (settings)' };
    }
    const core = this.app.internalPlugins && this.app.internalPlugins.plugins['daily-notes'];
    if (core && core.enabled && core.instance && core.instance.options) {
      const opts = core.instance.options;
      // The core plugin only returns values for fields the user has explicitly set;
      // a missing field means "default value", not "not configured".
      return {
        format: opts.format || 'YYYY-MM-DD',
        folder: opts.folder || '',
        source: 'Core plugin "Daily notes"',
      };
    }
    const periodic = this.app.plugins && this.app.plugins.plugins['periodic-notes'];
    // Note: the "enabled" flag doesn't exist per-interval in every Periodic Notes
    // version, so we treat the mere presence of settings.daily as "configured".
    if (periodic && periodic.settings && periodic.settings.daily) {
      return {
        format: periodic.settings.daily.format || 'YYYY-MM-DD',
        folder: periodic.settings.daily.folder || '',
        source: 'Community plugin "Periodic Notes"',
      };
    }
    return { format: 'YYYY-MM-DD', folder: '', source: 'Default (no daily notes plugin detected)' };
  }

  getDateFromFile(file) {
    const { format, source } = this.getDailyNoteInfo();
    let m = moment(file.basename, format, true);
    if (!m.isValid()) {
      // Second attempt without strict mode, only accepted if reformatting the
      // result exactly reproduces the filename (prevents false positives like
      // "Meeting-Notes-2026").
      const loose = moment(file.basename, format, false);
      if (loose.isValid() && loose.format(format) === file.basename) {
        m = loose;
      }
    }
    if (!m.isValid()) {
      console.warn(
        `Todoist Daily Archive: filename "${file.basename}" does not match the detected format ` +
        `"${format}" (source: ${source}). You can override the date format manually under ` +
        `Settings -> Todoist Daily Archive if needed.`
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
    // Fallback: search the whole vault for a file with a matching basename.
    const base = m.format(format);
    const files = this.app.vault.getMarkdownFiles();
    return files.find((f) => f.basename === base) || null;
  }

  async archiveForRelativeDay(offsetDays) {
    if (!this.hasSecretStorage()) {
      new Notice('This Obsidian version does not support the keychain (SecretStorage) yet. Please update to at least 1.11.4.');
      return;
    }
    if (!this.getApiToken()) {
      new Notice('No Todoist API token configured (Settings -> Todoist Daily Archive).');
      return;
    }
    const date = moment().add(offsetDays, 'days');
    const file = await this.findDailyNoteForDate(date);
    if (!file) {
      new Notice(`No daily note found for ${date.format('YYYY-MM-DD')}.`);
      return;
    }
    await this.runArchive(file, date);
  }

  async archiveForFile(file) {
    if (!this.hasSecretStorage()) {
      new Notice('This Obsidian version does not support the keychain (SecretStorage) yet. Please update to at least 1.11.4.');
      return;
    }
    if (!this.getApiToken()) {
      new Notice('No Todoist API token configured (Settings -> Todoist Daily Archive).');
      return;
    }
    const date = this.getDateFromFile(file);
    if (!date) {
      const { format, source } = this.getDailyNoteInfo();
      new Notice(
        `This file doesn't look like a daily note.\n` +
        `Detected format: "${format}" (source: ${source})\n` +
        `Filename: "${file.basename}"\n` +
        `See the developer console for details (Ctrl/Cmd+Shift+I).`,
        10000
      );
      return;
    }
    await this.runArchive(file, date);
  }

  async runArchive(file, date) {
    const since = date.clone().startOf('day').utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
    const until = date.clone().endOf('day').utc().format('YYYY-MM-DDTHH:mm:ss[Z]');

    new Notice('Loading completed Todoist tasks ...');
    let tasks;
    try {
      tasks = await this.fetchCompletedTasks(since, until);
    } catch (e) {
      console.error('Todoist Daily Archive:', e);
      new Notice('Error while fetching from the Todoist API: ' + e.message);
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
      new Notice(`No completed tasks found for ${date.format('YYYY-MM-DD')}.`);
      return;
    }

    const inserted = await this.insertIntoNote(file, tasks);
    if (inserted === 0) {
      new Notice('All matching tasks were already archived.');
    } else {
      new Notice(`Archived ${inserted} task(s) into "${file.basename}".`);
    }
  }

  async fetchCompletedTasks(since, until) {
    const token = this.getApiToken();
    if (!token) throw new Error('No Todoist API token found in the keychain.');
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
        throw new Error(`HTTP ${res.status} while loading completed tasks: ${(res.text || '').slice(0, 200)}`);
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
        console.warn('Todoist Daily Archive: could not load project names.', e);
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
    // Content must not contain unpaired [ ] inside a markdown link text, or the link breaks.
    const rawContent = (task.content || '').trim();
    const content = rawContent.split('[').join('\\[').split(']').join('\\]');
    const project = task.projectName ? ` (${task.projectName})` : '';
    const date = task.completed_at ? moment(task.completed_at).format('YYYY-MM-DD HH:mm') : '';
    // Todoist returns a "url" field per task; fall back to the current web app
    // URL scheme in the unlikely case it's missing.
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

  // Checks whether a line counts as a "blank line" directly under a heading.
  // Inside a callout/blockquote the line must still carry the ">" prefix
  // (otherwise the callout would already have ended at that point); outside a
  // callout it may simply be empty after removing any prefix.
  isBlankSeparatorLine(line, requireQuotePrefix) {
    if (line === undefined) return false;
    const quoteMatch = /^((?:>\s?)*)/.exec(line);
    const prefix = quoteMatch ? quoteMatch[1] : '';
    const rest = line.slice(prefix.length);
    if (requireQuotePrefix && prefix.length === 0) return false;
    return rest.trim() === '';
  }

  // Finds an ATX heading (#, ##, ...), even when nested inside a blockquote or
  // callout (lines with a leading ">" or "> > ..."). Returns level, text, and
  // the exact blockquote prefix (empty string if there is none).
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

    // Look for an existing heading with exactly matching level and text
    // (also inside a callout/blockquote).
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
      // Heading doesn't exist yet: create it at the end of the file, with a
      // blank line between the heading and the archived tasks.
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(this.buildHeadingLine());
      lines.push('');
      lines.push(...newLines);
    } else {
      // There must be a blank line directly under the heading (inside a
      // callout: a line with the same ">" prefix but no content). Insert it
      // once if missing; if it's already there, leave everything untouched
      // (no accumulation across repeated archiving runs).
      if (!this.isBlankSeparatorLine(lines[headingIdx + 1], !!headingPrefix)) {
        const separator = headingPrefix ? headingPrefix.trimEnd() : '';
        lines.splice(headingIdx + 1, 0, separator);
      }

      // Determine the end of the section: the next heading with equal or
      // higher rank (i.e. equal or fewer #). New content is appended just
      // before that boundary, so repeated archiving runs don't scramble the
      // order. If the heading is inside a callout, the section additionally
      // ends at the latest where the blockquote itself ends (first line
      // without a leading ">").
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
      // Skip trailing blank lines at the end of the section, so new lines
      // land directly under the last existing content instead of after a gap.
      // Must not run back past the mandatory blank line right under the heading.
      let insertAt = sectionEnd;
      while (insertAt > headingIdx + 2 && lines[insertAt - 1].trim() === '') insertAt--;

      // If the heading is inside a callout/blockquote, new lines need the
      // same ">" prefix, or they would visually fall outside the callout.
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
        .setName('Todoist API token')
        .setDesc(
          'Personal token from Todoist: Settings -> Integrations -> Developer. ' +
          'Stored via the Obsidian keychain (SecretStorage), not in data.json - ' +
          'so it stays out of synced vault files. Only the name of the secret is ' +
          'kept in the plugin settings, never the token value itself.'
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
        .setName('Todoist API token')
        .setDesc(
          'The keychain (SecretStorage) is only available from Obsidian 1.11.4 onward. ' +
          'Please update Obsidian - for security reasons this plugin deliberately does ' +
          'not offer a plaintext fallback field.'
        );
    }

    new Setting(containerEl)
      .setName('Heading level')
      .setDesc('Hierarchy level of the heading under which tasks are archived (# to ######).')
      .addDropdown((dropdown) => {
        for (let level = 1; level <= 6; level++) {
          dropdown.addOption(String(level), '#'.repeat(level) + ` (level ${level})`);
        }
        dropdown.setValue(String(this.plugin.settings.headingLevel)).onChange(async (value) => {
          this.plugin.settings.headingLevel = parseInt(value, 10);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Heading text')
      .setDesc(
        'Text of the heading under which tasks are inserted (without #). If a heading with ' +
        'exactly this text already exists at the configured level, tasks are appended at the ' +
        'end of that section (up to the next heading of equal or higher rank). If it doesn\'t ' +
        'exist yet, it is created at the end of the file.'
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
      .setName('Project filter (optional)')
      .setDesc('Comma-separated list of Todoist project names. Leave empty for all projects.')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.projectFilter)
          .onChange(async (value) => {
            this.plugin.settings.projectFilter = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Line template')
      .setDesc('Placeholders: {content}, {project}, {date}, {url} (link to the task in Todoist)')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.taskTemplate)
          .onChange(async (value) => {
            this.plugin.settings.taskTemplate = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Avoid duplicates')
      .setDesc('Do not re-insert tasks that were already archived (tracked via a hidden ID marker in the text).')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dedupe).onChange(async (value) => {
          this.plugin.settings.dedupe = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Override daily note date format (optional)')
      .setDesc(
        'Only set this if neither the core "Daily notes" plugin nor "Periodic Notes" is ' +
        'active/detectable. Moment.js format, e.g. YYYY-MM-DD.'
      )
      .addText((text) =>
        text
          .setPlaceholder('e.g. YYYY-MM-DD')
          .setValue(this.plugin.settings.dailyNoteFormatOverride)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteFormatOverride = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
