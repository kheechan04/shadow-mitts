// One Euro filter (Casiez et al. 2012). Time in seconds.

function alpha(cutoffHz: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private tPrev = 0;

  constructor(private params: () => OneEuroParams) {}

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, tSec: number): number {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.tPrev = tSec;
      return value;
    }
    const dt = tSec - this.tPrev;
    if (dt <= 0) return this.x;
    this.tPrev = tSec;
    const { minCutoff, beta, dCutoff } = this.params();
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}
