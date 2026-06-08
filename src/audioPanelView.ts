import { ItemView, WorkspaceLeaf, TFile, getLinkpath, setIcon, Notice, Modal } from 'obsidian';
import { secondsToNumber, secondsToString } from './utils';
import type AudioPlayer from './main';

export const VIEW_TYPE_AUDIO_PANEL = 'audio-player-panel';

type AudioEntry = {
  timeString: string;
  timeNumber: number;
  content: string;
};

type Block = {
  filename: string;
  file?: TFile;
  entries: AudioEntry[];
  lineNumber: number;
};

export class AudioPanelView extends ItemView {
  plugin: AudioPlayer;
  container: HTMLElement;
  private _updating = false;
  private playBtnByPath: Map<string, { el: HTMLElement; resourcePath: string }> = new Map();
  private progressByPath: Map<string, { slider: HTMLInputElement; timeEl: HTMLElement; resourcePath: string }> = new Map();

  constructor(leaf: WorkspaceLeaf, plugin: AudioPlayer) {
    super(leaf);
    this.plugin = plugin;
    this.container = this.contentEl;
  }

  getViewType() {
    return VIEW_TYPE_AUDIO_PANEL;
  }
  getDisplayText() {
    return 'Audio Player';
  }

  async onOpen() {
    this.container = this.contentEl;
    this.container.empty();

    const header = this.container.createDiv('audio-panel-header');
    const headerIcon = header.createDiv('audio-panel-header-icon');
    setIcon(headerIcon, 'audio-file');
    header.createEl('h5', { text: 'Audio Player' });
    const refresh = header.createEl('button', { text: 'Refresh' });
    refresh.addEventListener('mousedown', (e) => { e.preventDefault(); this.update(); });

    this.update();

    // refresh when active file changes
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.update()));
    this.registerEvent(this.app.vault.on('modify', () => this.update()));

    // update UI when global play/pause occurs elsewhere
    document.addEventListener('allpause', () => {
      this.playBtnByPath.forEach(({ el }) => setIcon(el, 'play'));
    });
    document.addEventListener('allresume', () => {
      const player = this.plugin.audioPlayer;
      if (!player?.src) return;
      for (const [, { el, resourcePath }] of this.playBtnByPath) {
        if (player.src === resourcePath) {
          setIcon(el, 'pause');
          break;
        }
      }
    });

    // sync play button and progress bar when waveform seeks
    document.addEventListener('audio-time-seek', (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (!detail?.path) return;
      const btnEntry = this.playBtnByPath.get(detail.path);
      if (btnEntry) {
        const player = this.plugin.audioPlayer;
        if (player && player.src && !player.paused) {
          setIcon(btnEntry.el, 'pause');
        } else {
          setIcon(btnEntry.el, 'play');
        }
      }
      // also sync progress bar
      const progEntry = this.progressByPath.get(detail.path);
      if (progEntry && detail.time !== undefined) {
        progEntry.slider.value = String(detail.time);
        progEntry.timeEl.setText(secondsToString(detail.time));
      }
    });

    // keep progress bar in sync with audio playback
    this.plugin.audioPlayer?.addEventListener('timeupdate', () => {
      const player = this.plugin.audioPlayer;
      if (!player?.src) return;
      for (const [, entry] of this.progressByPath) {
        if (player.src === entry.resourcePath) {
          if (entry.slider.dataset.seeking === 'true') return;
          const dur = player.duration;
          if (dur && isFinite(dur)) {
            entry.slider.max = String(dur);
          }
          entry.slider.value = String(player.currentTime);
          entry.timeEl.setText(secondsToString(player.currentTime));
          break;
        }
      }
    });
  }

  async onClose(): Promise<void> {
    // nothing
  }

  async insertBookmark(file: TFile, src: string, timeStr: string, desc: string) {
    const text = await this.app.vault.read(file);
    const regex = /```audio-player\n([\s\S]*?)\n```/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const body = match[1];
      const linkRe = /\[\[(.+)\]\]/;
      const linkMatch = linkRe.exec(body);
      if (!linkMatch) continue;
      const fname = linkMatch[1].trim();
      const link = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(fname), fname);
      if (!link) continue;
      if (this.app.vault.getResourcePath(link) === src) {
        const insertPos = match.index + match[0].length - 3;
        const newLine = `${timeStr} --- ${desc}\n`;
        const newText = text.slice(0, insertPos) + newLine + text.slice(insertPos);
        await this.app.vault.modify(file, newText);
        new Notice('Bookmark added');
        return;
      }
    }
    new Notice('No matching audio-player block found');
  }

  async update() {
    if (this._updating) return;
    this._updating = true;
    try {
    this.playBtnByPath.clear();
    this.progressByPath.clear();
    this.container.empty();
    const header = this.container.createDiv('audio-panel-header');
    header.createEl('h5', { text: 'Audio Player' });
    const bookmarkBtn = header.createEl('button', { text: 'Bookmark' });
    const refresh = header.createEl('button', { text: 'refresh' });
    refresh.addEventListener('mousedown', (e) => { e.preventDefault(); this.update(); });

    bookmarkBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const player = this.plugin.audioPlayer;
      if (!player?.src) {
        new Notice('No audio playing');
        return;
      }
      const timeStr = secondsToString(player.currentTime);
      const file = this.app.workspace.getActiveFile();
      if (!file) return;

      const modal = new Modal(this.app);
      modal.titleEl.setText('Add bookmark');
      const input = modal.contentEl.createEl('input', { type: 'text', attr: { placeholder: 'Description' } });
      input.style.width = '100%';
      input.style.marginBottom = '10px';
      modal.contentEl.createEl('div', { text: `Time: ${timeStr}` });

      const submit = () => {
        const desc = input.value.trim();
        modal.close();
        if (!desc) return;
        this.insertBookmark(file, player.src, timeStr, desc);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

      const btnWrap = modal.contentEl.createDiv();
      btnWrap.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
      const okBtn = btnWrap.createEl('button', { text: 'Add' });
      okBtn.addEventListener('click', submit);
      const cancelBtn = btnWrap.createEl('button', { text: 'Cancel' });
      cancelBtn.addEventListener('click', () => modal.close());

      setTimeout(() => input.focus(), 50);
      modal.open();
    });

    const active = this.app.workspace.getActiveFile();
    if (!active) {
      this.container.createDiv('audio-panel-empty', (el) => el.setText('No active file.'));
      return;
    }

    const text = await this.app.vault.read(active);
    const blocks = this.parseBlocks(text);
    if (blocks.length == 0) {
      this.container.createDiv('audio-panel-empty', (el) => el.setText('No `audio-player` blocks in this file.'));
      return;
    }

    blocks.forEach((blk) => {
        const blockEl = this.container.createDiv('audio-panel-block');
      const titleEl = blockEl.createEl('div', { text: `File: ${blk.filename}` });
      titleEl.addClass('audio-panel-block-title');
      titleEl.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(active);
        const editor = (leaf.view as any)?.editor;
        if (editor) {
          editor.setCursor(blk.lineNumber, 0);
          editor.scrollIntoView(
            { from: { line: blk.lineNumber, ch: 0 }, to: { line: blk.lineNumber, ch: 0 } },
            true
          );
        }
      });

      const file = blk.file;
      if (!file) {
        blockEl.createDiv('audio-panel-missing', (el) => el.setText('Referenced audio file not found.'));
        return;
      }

      // block-level controls (play/pause + rate slider)
      const bcontrols = blockEl.createDiv('audio-panel-block-controls');
      const resourcePath = this.app.vault.getResourcePath(file);

      // rewind -4s button
      const rewindBtn = bcontrols.createDiv('audio-panel-block-skip');
      setIcon(rewindBtn, 'skip-back');

      const playBtn = bcontrols.createDiv('audio-panel-block-play');
      setIcon(playBtn, 'play');
      this.playBtnByPath.set(file.path, { el: playBtn, resourcePath });

      // forward +4s button
      const forwardBtn = bcontrols.createDiv('audio-panel-block-skip');
      setIcon(forwardBtn, 'skip-forward');

      const rateWrap = bcontrols.createDiv('audio-panel-block-rate');
      const decBtn = rateWrap.createDiv('audio-panel-rate-btn', (el) => el.setText('-'));
      const rateValue = rateWrap.createDiv('audio-panel-rate-value', (el) => el.setText('1.0'));
      const incBtn = rateWrap.createDiv('audio-panel-rate-btn', (el) => el.setText('+'));

      // current rate for this file (default 1.0)
      let currentRate = 1.0;
      try {
        const saved = localStorage[`${file.path}_rate`];
        if (saved) {
          currentRate = Number.parseFloat(saved);
        }
      } catch (err) {}

      const formatRate = (r: number) => {
        const s = parseFloat(r.toFixed(2)).toString();
        return s.includes('.') ? s : s + '.0';
      };

      rateValue.setText(formatRate(currentRate));

      // helper to broadcast rate changes
      const broadcastRate = (r: number) => {
        currentRate = r;
        try { localStorage[`${file.path}_rate`] = String(r); } catch (e) {}
        rateValue.setText(formatRate(r));
        const player = this.plugin.audioPlayer;
        if (player && player.src === resourcePath) player.playbackRate = r;
        document.dispatchEvent(new CustomEvent('panel-rate', { detail: { path: file.path, rate: r } }));
      };

      playBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const player = this.plugin.audioPlayer;
        if (!player) return;

        // if same file and playing -> pause
        if (player.src === resourcePath && !player.paused) {
          player.pause();
          setIcon(playBtn, 'play');
          document.dispatchEvent(new Event('allpause'));
          return;
        }

        document.dispatchEvent(new Event('allpause'));

        // only reset time when switching to a different file
        const sameFile = player.src === resourcePath;
        if (!sameFile) {
          player.src = resourcePath;
          player.currentTime = 0;
        }
        try {
          const saved = localStorage[`${file.path}_rate`];
          if (saved) player.playbackRate = Number.parseFloat(saved);
          else player.playbackRate = currentRate;
        } catch (e) { player.playbackRate = currentRate; }
        player.play();
        setIcon(playBtn, 'pause');
        document.dispatchEvent(new Event('allresume'));
        // ensure other UI syncs rate
        document.dispatchEvent(new CustomEvent('panel-rate', { detail: { path: file.path, rate: player.playbackRate } }));
      });

      // skip -4s
      rewindBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const player = this.plugin.audioPlayer;
        if (!player?.src) return;
        player.currentTime = Math.max(0, player.currentTime - 4);
        document.dispatchEvent(new CustomEvent('audio-time-seek', { detail: { path: file.path, time: player.currentTime } }));
      });

      // skip +4s
      forwardBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const player = this.plugin.audioPlayer;
        if (!player?.src) return;
        player.currentTime = Math.min(player.duration || Infinity, player.currentTime + 4);
        document.dispatchEvent(new CustomEvent('audio-time-seek', { detail: { path: file.path, time: player.currentTime } }));
      });

      // +/- buttons to step rate by 0.25
      decBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        let newv = Math.round((currentRate - 0.25) * 100) / 100;
        if (newv < 0.25) newv = 0.25;
        broadcastRate(newv);
      });
      incBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        let newv = Math.round((currentRate + 0.25) * 100) / 100;
        if (newv > 3) newv = 3;
        broadcastRate(newv);
      });

      // progress bar
      const progressWrap = blockEl.createDiv('audio-panel-progress');
      const timeEl = progressWrap.createSpan('audio-panel-progress-time');
      timeEl.setText('00:00:00');
      const slider = progressWrap.createEl('input');
      slider.type = 'range';
      slider.addClass('audio-panel-progress-slider');
      slider.min = '0';
      slider.max = '100';
      slider.value = '0';
      slider.step = '0.1';

      slider.addEventListener('pointerdown', () => { slider.dataset.seeking = 'true'; });
      slider.addEventListener('pointerup', () => { slider.dataset.seeking = 'false'; });
      slider.addEventListener('input', () => {
        const player = this.plugin.audioPlayer;
        if (!player) return;
        const t = Number(slider.value);
        player.currentTime = t;
        timeEl.setText(secondsToString(t));
        document.dispatchEvent(new CustomEvent('audio-time-seek', { detail: { path: file.path, time: t } }));
      });

      this.progressByPath.set(file.path, { slider, timeEl, resourcePath });

      // update play button state based on current global player
      const player = this.plugin.audioPlayer;
      if (player && player.src === resourcePath && !player.paused) {
        setIcon(playBtn, 'pause');
      }

      // for each entry, create a row (simplified)
      blk.entries.forEach((e) => {
        const row = blockEl.createDiv('audio-panel-entry');
        const left = row.createDiv('audio-panel-entry-left');
        left.createEl('button', { text: e.timeString }).addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          const player = this.plugin.audioPlayer;
          if (!player) return;
          document.dispatchEvent(new Event('allpause'));

          // only set src when switching to a different file
          if (player.src !== resourcePath) {
            player.src = resourcePath;
          }

          player.currentTime = e.timeNumber;
          // apply saved playback rate
          try {
            const saved = localStorage[`${file.path}_rate`];
            if (saved) player.playbackRate = Number.parseFloat(saved);
          } catch (e) {}
          player.play();

          setIcon(playBtn, 'pause');
          document.dispatchEvent(new Event('allresume'));
          // notify waveform to sync immediately
          document.dispatchEvent(new CustomEvent('audio-time-seek', { detail: { path: file.path, time: e.timeNumber } }));
        });

        row.createDiv('audio-panel-entry-content', (el) => el.setText(e.content));
      });
    });
    } finally {
      this._updating = false;
    }
  }

  parseBlocks(text: string): Block[] {
    const regex = /```audio-player\n([\s\S]*?)\n```/g;
    // Avoid using String.matchAll for compatibility with older TS lib targets.
    const matches: RegExpExecArray[] = [];
    let _m: RegExpExecArray | null;
    // regex has the /g flag, so exec can be used in a loop to collect matches
    while ((_m = regex.exec(text)) !== null) {
      matches.push(_m);
    }
    const blocks: Block[] = [];

    for (const m of matches) {
      const body = m[1];
      const lineNumber = text.substring(0, m.index).split('\n').length - 1;
      const linkRe = /\[\[(.+)\]\]/;
      const linkMatch = linkRe.exec(body);
      if (!linkMatch) continue;
      const filename = linkMatch[1].trim();
      const link = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(filename), filename);
      const entries: AudioEntry[] = [];

      const lines = body.split('\n').map((l) => l.trim());

      for (const l of lines) {
        const tsRe = /^(\d{2}:\d{2}:\d{2})\s*---\s*(.*)$/;
        const tsMatch = tsRe.exec(l);
        if (tsMatch) {
          const tstr = tsMatch[1];
          const content = tsMatch[2];
          entries.push({ timeString: tstr, timeNumber: secondsToNumber(tstr), content });
        }
      }

      blocks.push({ filename, file: link || undefined, entries, lineNumber });
    }

    return blocks;
  }
}
