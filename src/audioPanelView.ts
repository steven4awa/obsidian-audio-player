import { ItemView, WorkspaceLeaf, TFile, getLinkpath, setIcon } from 'obsidian';
import { secondsToNumber } from './utils';
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
};

export class AudioPanelView extends ItemView {
  plugin: AudioPlayer;
  container: HTMLElement;
  private _updating = false;
  private playBtnByPath: Map<string, HTMLElement> = new Map();

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
    refresh.addEventListener('click', () => this.update());

    this.update();

    // refresh when active file changes
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.update()));
    this.registerEvent(this.app.vault.on('modify', () => this.update()));

    // update UI when global play/pause occurs elsewhere
    document.addEventListener('allpause', () => this.update());
    document.addEventListener('allresume', () => this.update());

    // sync play button state when waveform seeks
    document.addEventListener('audio-time-seek', (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (!detail?.path) return;
      const btn = this.playBtnByPath.get(detail.path);
      if (!btn) return;
      const player = this.plugin.audioPlayer;
      if (player && player.src && !player.paused) {
        setIcon(btn, 'pause');
      } else {
        setIcon(btn, 'play');
      }
    });
  }

  async onClose(): Promise<void> {
    // nothing
  }

  async update() {
    if (this._updating) return;
    this._updating = true;
    try {
    this.container.empty();
    const header = this.container.createDiv('audio-panel-header');
    header.createEl('h5', { text: 'Audio Player' });
    const refresh = header.createEl('button', { text: 'refresh' });
    refresh.addEventListener('click', () => this.update());

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
      blockEl.createEl('div', { text: `File: ${blk.filename}` }).addClass('audio-panel-block-title');

      const file = blk.file;
      if (!file) {
        blockEl.createDiv('audio-panel-missing', (el) => el.setText('Referenced audio file not found.'));
        return;
      }

      // block-level controls (play/pause + rate slider)
      const bcontrols = blockEl.createDiv('audio-panel-block-controls');
      const playBtn = bcontrols.createDiv('audio-panel-block-play');
      setIcon(playBtn, 'play');
      this.playBtnByPath.set(file.path, playBtn);

      const rateWrap = bcontrols.createDiv('audio-panel-block-rate');
      const decBtn = rateWrap.createDiv('audio-panel-rate-btn', (el) => el.setText('-'));
      const rateValue = rateWrap.createDiv('audio-panel-rate-value', (el) => el.setText('1.0'));
      const incBtn = rateWrap.createDiv('audio-panel-rate-btn', (el) => el.setText('+'));

      const resourcePath = this.app.vault.getResourcePath(file);

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

      playBtn.addEventListener('click', () => {
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

      // +/- buttons to step rate by 0.25
      decBtn.addEventListener('click', () => {
        let newv = Math.round((currentRate - 0.25) * 100) / 100;
        if (newv < 0.25) newv = 0.25;
        broadcastRate(newv);
      });
      incBtn.addEventListener('click', () => {
        let newv = Math.round((currentRate + 0.25) * 100) / 100;
        if (newv > 3) newv = 3;
        broadcastRate(newv);
      });

      // update play button state based on current global player
      const player = this.plugin.audioPlayer;
      if (player && player.src === resourcePath && !player.paused) {
        setIcon(playBtn, 'pause');
      }

      // for each entry, create a row (simplified)
      blk.entries.forEach((e) => {
        const row = blockEl.createDiv('audio-panel-entry');
        const left = row.createDiv('audio-panel-entry-left');
        left.createEl('button', { text: e.timeString }).addEventListener('click', () => {
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

      blocks.push({ filename, file: link || undefined, entries });
    }

    return blocks;
  }
}
