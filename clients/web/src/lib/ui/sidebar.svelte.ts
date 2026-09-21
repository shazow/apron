import { loadSidebarPrefs, saveSidebarPrefs } from './storage';

const MIN_W = 160;
const MAX_W = 480;
const DEFAULT_W = 248;
const KEY_STEP = 16;

/** The sidebar's width, user-resizable by dragging its right border; a plain click on the border collapses or expands it. */
export class SidebarLayout {
	width = $state(DEFAULT_W);
	collapsed = $state(false);
	resizing = $state(false);

	load(): void {
		const saved = loadSidebarPrefs();
		if (saved.width !== undefined) this.width = clamp(saved.width);
		if (saved.collapsed !== undefined) this.collapsed = saved.collapsed;
	}

	toggle(): void {
		this.collapsed = !this.collapsed;
		this.save();
	}

	startResize(event: PointerEvent): void {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget as HTMLElement;
		const startX = event.clientX;
		const startWidth = this.collapsed ? 0 : this.width;
		let moved = false;
		handle.setPointerCapture(event.pointerId);
		this.resizing = true;
		const onMove = (e: PointerEvent) => {
			const dx = e.clientX - startX;
			if (!moved && Math.abs(dx) < 4) return;
			moved = true;
			const next = startWidth + dx;
			if (next < MIN_W / 2) {
				this.collapsed = true;
			} else {
				this.collapsed = false;
				this.width = clamp(next);
			}
		};
		const onUp = () => {
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			handle.removeEventListener('pointercancel', onUp);
			handle.releasePointerCapture(event.pointerId);
			this.resizing = false;
			if (!moved) this.collapsed = !this.collapsed;
			this.save();
		};
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
		handle.addEventListener('pointercancel', onUp);
	}

	/** Arrows resize; Enter and Space toggle through the handle's native click. */
	handleKey(event: KeyboardEvent): void {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		if (this.collapsed) {
			if (event.key === 'ArrowRight') this.collapsed = false;
		} else {
			this.width = clamp(this.width + (event.key === 'ArrowLeft' ? -KEY_STEP : KEY_STEP));
		}
		this.save();
	}

	private save(): void {
		saveSidebarPrefs({ width: this.width, collapsed: this.collapsed });
	}
}

function clamp(width: number): number {
	return Math.min(MAX_W, Math.max(MIN_W, Math.round(width)));
}
