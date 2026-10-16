// Power hold coordination; kept separate from macOS commands so transitions
// can be tested without spawning caffeinate or changing system sleep settings.
export class PowerLifecycle<Context> {
	private runActive = false;
	private loopActive = false;

	constructor(
		private readonly engage: (ctx: Context) => void,
		private readonly release: (ctx: Context) => void,
	) {}

	loopChanged(active: boolean, ctx: Context): void {
		this.loopActive = active;
		this.releaseWhenIdle(ctx);
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
		this.release(ctx);
	}

	private releaseWhenIdle(ctx: Context): void {
		if (this.runActive || this.loopActive) this.engage(ctx);
		else this.release(ctx);
	}
}
