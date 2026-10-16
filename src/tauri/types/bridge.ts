import { TrackType } from './media';

/** A download sent from the browser extension (or an ovd-save-as:// link). */
export type BridgeRequest = {
  requestId: string;
  url: string;
  audioOnly: boolean;
  windowWasVisible: boolean;
  windowWasFocused: boolean;
  /** Read the formats and wait for the browser to pick one. */
  chooseFormat?: boolean;
};

/** The format picked in the browser. */
export type BridgeChoice = {
  requestId: string;
  trackType: TrackType;
  height?: number;
  fps?: number;
  abr?: number;
};

export type BridgeCommand
  = | ({ kind: 'download' } & BridgeRequest)
    | ({ kind: 'choose' } & BridgeChoice)
    | { kind: 'cancel'; requestId: string };

/** What the browser's format picker offers, in the app's own labels. */
export type BridgeChoices = {
  video: { height: number; fps?: number; label: string }[];
  audio: { abr?: number; label: string }[];
};

export type BridgeItemState
  = | 'fetching'
    | 'pick'
    | 'choosing'
    | 'saveAs'
    | 'ready'
    | 'downloading'
    | 'paused'
    | 'done'
    | 'error'
    | 'cancelled';

/** One download as the browser extension sees it. */
export type BridgeItem = {
  id: string;
  requestId?: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  state: BridgeItemState;
  stage?: string;
  percent?: number;
  speedBps?: number;
  etaSecs?: number;
  done?: number;
  total?: number;
  duration?: number;
  uploader?: string;
  /** Stays in the app; the extension only ever gets the file's name. */
  path?: string;
  error?: string;
  choices?: BridgeChoices;
  /** Still in the browser's picker; not a real download yet. */
  pending?: boolean;
};
