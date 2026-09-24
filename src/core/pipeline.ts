// Frame → features → punch events (with type). The one path used by the app, replay and tests.

import { classifyPunch } from './classify';
import { FeatureExtractor, type FrameFeatures } from './features';
import type { Params } from './params';
import type { PoseFrame, Side } from './pose';
import { PunchDetector, type PunchEvent } from './punch';

export class RecognitionPipeline {
  private extractor: FeatureExtractor;
  private detector: PunchDetector;

  constructor(private params: () => Params, aspect: number) {
    this.extractor = new FeatureExtractor(params, aspect);
    this.detector = new PunchDetector(params);
  }

  reset(): void {
    this.extractor.reset();
    this.detector.reset();
  }

  update(frame: PoseFrame): { features: FrameFeatures | null; events: PunchEvent[] } {
    const features = this.extractor.update(frame);
    const p = this.params();
    const events = this.detector.update(features).map((ev) => {
      const c = classifyPunch(ev.features, p);
      return { ...ev, kind: c.kind, confidence: c.confidence };
    });
    return { features, events };
  }

  armState(side: Side) {
    return this.detector.debugState(side);
  }
}
