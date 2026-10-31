import ELK from 'elkjs/lib/elk-api.js';
import elkWorker from 'elkjs/lib/elk-worker.min.js?url';
import type { Scene } from './scene.ts';
import { layoutWith, type LayoutInput, type LayoutResult } from './elk-graph.ts';

export type { LayoutInput, LayoutResult };

// ELK runs in its own worker, so a 1,500-node layout never freezes the board.
const elk = new ELK({ workerUrl: elkWorker });

export const layout = (scene: Scene, direction: LayoutInput['direction']): Promise<LayoutResult> => layoutWith(elk, scene, direction);
