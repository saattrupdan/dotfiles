// Power hold coordination; kept separate from macOS commands so transitions
// can be tested without spawning caffeinate or changing system sleep settings.
export class PowerLifecycle<Context> {
	private runActive = false;
	private loopActive = false;
	private holdAfterLoop = false;
	private lidTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly engage: (ctx: Context) => void,
		private readonly release: (ctx: Context) => void,
		private readonly isEngaged: () => boolean,
		private readonly isLidClosed: () => boolean,
		private readonly setTimer: typeof setInterval = setInterval,
		private readonly clearTimer: typeof clearInterval = clearInterval,
	) {}

	get waitingForLid(): boolean {
		return this.holdAfterLoop && !this.runActive && !this.loopActive && this.isEngaged();
	}

	loopChanged(active: boolean, ctx: Context): void {
		this.loopActive = active;
		if (active) this.engage(ctx);
		else {
			this.holdAfterLoop = true;
			this.releaseWhenIdle(ctx);
		}
	}

	agentStarted(ctx: Context): void {
		this.runActive = true;
		this.engage(ctx);
	}

	agentEnded(ctx: Context): void {
		this.runActive = false;
		this.releaseWhenIdle(ctx);
	}

	stop(ctx: Context): void {
		this.runActive = false;
		this.loopActive = false;
		this.holdAfterLoop = false;
		if (this.lidTimer !== undefined) {
			this.clearTimer(this.lidTimer);
			this.lidTimer = undefined;
		}
		this.release(ctx);
	}

	private releaseWhenIdle(ctx: Context): void {
		if (this.runActive || this.loopActive) return;
		if (this.holdAfterLoop && this.isEngaged() && this.isLidClosed()) {
			// A completed loop cannot trigger sleep with the lid shut. The
			// privileged watcher still enforces its battery thermal cutoff.
			if (this.lidTimer === undefined) {
				this.lidTimer = this.setTimer(() => {
					if (!this.runActive && !this.loopActive && !this.isLidClosed()) this.stop(ctx);
				}, 5_000);
			}
			return;
		}
		this.stop(ctx);
	}
}
