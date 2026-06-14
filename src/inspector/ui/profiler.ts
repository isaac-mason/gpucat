import { injectStyle } from './style';
import type { Tab } from './tab';

interface DetachedWindow {
	panel: HTMLElement;
	tab: Tab;
}

interface LayoutData {
	position: string;
	lastHeightBottom: number;
	lastWidthRight: number;
	activeTabId: string | null;
	detachedTabs: DetachedTabData[];
	isVisible: boolean;
}

interface DetachedTabData {
	tabId: string;
	originalIndex: number;
	left: number;
	top: number;
	width: number;
	height: number;
}

export class Profiler {

	domElement!: HTMLDivElement;
	toggleButton!: HTMLButtonElement;
	builtinTabsContainer!: HTMLElement;
	miniPanel!: HTMLDivElement;
	panel!: HTMLDivElement;
	tabsContainer!: HTMLDivElement;
	contentWrapper!: HTMLDivElement;
	floatingBtn!: HTMLButtonElement;
	maximizeBtn!: HTMLButtonElement;

	tabs: Record<string, Tab> = {};
	activeTabId: string | null = null;
	isResizing = false;
	lastHeightBottom = 350;
	lastWidthRight = 450;
	position = 'bottom';
	detachedWindows: DetachedWindow[] = [];
	isMobile: boolean;
	maxZIndex = 1002;
	nextTabOriginalIndex = 0;
	isLoadingLayout = false;
	pendingDetachedTabs: DetachedTabData[] | null = null;

	/** Persistent window listeners, stashed so dispose() can remove them. */
	private _orientationListener: (() => void) | null = null;
	private _resizeListener: (() => void) | null = null;

	constructor() {
		this.isMobile = this.detectMobile();

		injectStyle();

		this.setupShell();
		this.setupResizing();

		if (this.isMobile) {
			this.setupOrientationListener();
		}

		this.setupWindowResizeListener();
	}

	detectMobile(): boolean {
		const userAgent = navigator.userAgent || navigator.vendor || (window as unknown as { opera: string }).opera;
		const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
		const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
		const isSmallScreen = window.innerWidth <= 768;
		return isMobileUA || (isTouchDevice && isSmallScreen);
	}

	setupOrientationListener(): void {
		const handleOrientationChange = () => {
			const isLandscape = window.innerWidth > window.innerHeight;
			const targetPosition = isLandscape ? 'right' : 'bottom';
			if (this.position !== targetPosition) {
				this.setPosition(targetPosition);
			}
		};
		handleOrientationChange();
		this._orientationListener = handleOrientationChange;
		window.addEventListener('orientationchange', handleOrientationChange);
		window.addEventListener('resize', handleOrientationChange);
	}

	setupWindowResizeListener(): void {
		const constrainDetachedWindows = () => {
			this.detachedWindows.forEach(dw => this.constrainWindowToBounds(dw.panel));
		};

		const constrainMainPanel = () => {
			if (this.panel.classList.contains('maximized')) return;
			const windowWidth = window.innerWidth;
			const windowHeight = window.innerHeight;

			if (this.position === 'bottom') {
				const currentHeight = this.panel.offsetHeight;
				const maxHeight = windowHeight - 50;
				if (currentHeight > maxHeight) {
					this.panel.style.height = `${maxHeight}px`;
					this.lastHeightBottom = maxHeight;
				}
			} else if (this.position === 'right') {
				const currentWidth = this.panel.offsetWidth;
				const maxWidth = windowWidth - 50;
				if (currentWidth > maxWidth) {
					this.panel.style.width = `${maxWidth}px`;
					this.lastWidthRight = maxWidth;
				}
			}
		};

		const onResize = () => {
			constrainDetachedWindows();
			constrainMainPanel();
		};
		this._resizeListener = onResize;
		window.addEventListener('resize', onResize);
	}

	/**
	 * Tear down everything this Profiler installed on global state: persistent
	 * window listeners and detached tab panels (which live as `document.body`
	 * children, not under `domElement`). The main panel + its subtree are NOT
	 * removed here, the Inspector owns `domElement.remove()`.
	 */
	dispose(): void {
		if (this._orientationListener) {
			window.removeEventListener('orientationchange', this._orientationListener);
			window.removeEventListener('resize', this._orientationListener);
			this._orientationListener = null;
		}
		if (this._resizeListener) {
			window.removeEventListener('resize', this._resizeListener);
			this._resizeListener = null;
		}
		// Detached tab panels were appended to document.body, drop them here.
		for (const dw of this.detachedWindows) {
			dw.panel.remove();
		}
		this.detachedWindows.length = 0;
	}

	constrainWindowToBounds(windowPanel: HTMLElement): void {
		const windowWidth = window.innerWidth;
		const windowHeight = window.innerHeight;
		const panelWidth = windowPanel.offsetWidth;
		const panelHeight = windowPanel.offsetHeight;

		let left = parseFloat(windowPanel.style.left) || windowPanel.offsetLeft || 0;
		let top = parseFloat(windowPanel.style.top) || windowPanel.offsetTop || 0;

		const halfWidth = panelWidth / 2;
		const halfHeight = panelHeight / 2;

		if (left + panelWidth > windowWidth + halfWidth) left = windowWidth + halfWidth - panelWidth;
		if (left < -halfWidth) left = -halfWidth;
		if (top + panelHeight > windowHeight + halfHeight) top = windowHeight + halfHeight - panelHeight;
		if (top < -halfHeight) top = -halfHeight;

		windowPanel.style.left = `${left}px`;
		windowPanel.style.top = `${top}px`;
	}

	setupShell(): void {
		this.domElement = document.createElement('div');
		this.domElement.id = 'profiler-shell';

		this.toggleButton = document.createElement('button');
		this.toggleButton.id = 'profiler-toggle';
		this.toggleButton.innerHTML = `
<span id="builtin-tabs-container"></span>
<span id="toggle-text">
	<span id="fps-counter">-</span>
	<span class="fps-label">FPS</span>
</span>
<span id="toggle-icon">
	<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M11.5 20h-6.5a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v5.5" /><path d="M9 17h2" /><path d="M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M20.2 20.2l1.8 1.8" /></svg>
</span>
`;
		this.toggleButton.onclick = () => this.togglePanel();
		this.builtinTabsContainer = this.toggleButton.querySelector('#builtin-tabs-container')!;

		this.miniPanel = document.createElement('div');
		this.miniPanel.id = 'profiler-mini-panel';
		this.miniPanel.className = 'profiler-mini-panel';

		this.panel = document.createElement('div');
		this.panel.id = 'profiler-panel';

		const header = document.createElement('div');
		header.className = 'profiler-header';
		this.tabsContainer = document.createElement('div');
		this.tabsContainer.className = 'profiler-tabs';

		const controls = document.createElement('div');
		controls.className = 'profiler-controls';

		this.floatingBtn = document.createElement('button');
		this.floatingBtn.id = 'floating-btn';
		this.floatingBtn.title = 'Switch to Right Side';
		this.floatingBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line></svg>';
		this.floatingBtn.onclick = () => this.togglePosition();

		if (this.isMobile) {
			this.floatingBtn.style.display = 'none';
			this.panel.classList.add('hide-position-toggle');
		}

		this.maximizeBtn = document.createElement('button');
		this.maximizeBtn.id = 'maximize-btn';
		this.maximizeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
		this.maximizeBtn.onclick = () => this.toggleMaximize();

		const hideBtn = document.createElement('button');
		hideBtn.id = 'hide-panel-btn';
		hideBtn.textContent = '-';
		hideBtn.onclick = () => this.togglePanel();

		controls.append(this.floatingBtn, this.maximizeBtn, hideBtn);
		header.append(this.tabsContainer, controls);

		this.contentWrapper = document.createElement('div');
		this.contentWrapper.className = 'profiler-content-wrapper';

		const resizer = document.createElement('div');
		resizer.className = 'panel-resizer';

		this.panel.append(resizer, header, this.contentWrapper);
		this.domElement.append(this.toggleButton, this.miniPanel, this.panel);

		this.panel.classList.add(`position-${this.position}`);

		// Toggle pill and mini-panel are always anchored top-right,
		// independent of which direction the panel opens.
		this.toggleButton.classList.add('position-right');
		this.miniPanel.classList.add('position-right');
	}

	setupResizing(): void {
		const resizer = this.panel.querySelector('.panel-resizer') as HTMLDivElement;

		const onStart = (e: PointerEvent) => {
			this.isResizing = true;
			this.panel.classList.add('resizing');
			resizer.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startY = e.clientY;
			const startHeight = this.panel.offsetHeight;
			const startWidth = this.panel.offsetWidth;

			const onMove = (moveEvent: PointerEvent) => {
				if (!this.isResizing) return;
				moveEvent.preventDefault();
				if (this.position === 'bottom') {
					const newHeight = startHeight - (moveEvent.clientY - startY);
					if (newHeight > 100 && newHeight < window.innerHeight - 50) {
						this.panel.style.height = `${newHeight}px`;
					}
				} else if (this.position === 'right') {
					const newWidth = startWidth - (moveEvent.clientX - startX);
					if (newWidth > 200 && newWidth < window.innerWidth - 50) {
						this.panel.style.width = `${newWidth}px`;
					}
				}
			};

			const onEnd = () => {
				this.isResizing = false;
				this.panel.classList.remove('resizing');
				resizer.removeEventListener('pointermove', onMove);
				resizer.removeEventListener('pointerup', onEnd);
				resizer.removeEventListener('pointercancel', onEnd);
				if (!this.panel.classList.contains('maximized')) {
					if (this.position === 'bottom') this.lastHeightBottom = this.panel.offsetHeight;
					else if (this.position === 'right') this.lastWidthRight = this.panel.offsetWidth;
					this.saveLayout();
				}
			};

			resizer.addEventListener('pointermove', onMove);
			resizer.addEventListener('pointerup', onEnd);
			resizer.addEventListener('pointercancel', onEnd);
		};

		resizer.addEventListener('pointerdown', onStart);
	}

	toggleMaximize(): void {
		if (this.panel.classList.contains('maximized')) {
			this.panel.classList.remove('maximized');
			if (this.position === 'bottom') {
				this.panel.style.height = `${this.lastHeightBottom}px`;
				this.panel.style.width = '100%';
			} else if (this.position === 'right') {
				this.panel.style.height = '100%';
				this.panel.style.width = `${this.lastWidthRight}px`;
			}
			this.maximizeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
		} else {
			if (this.position === 'bottom') this.lastHeightBottom = this.panel.offsetHeight;
			else if (this.position === 'right') this.lastWidthRight = this.panel.offsetWidth;
			this.panel.classList.add('maximized');
			if (this.position === 'bottom') {
				this.panel.style.height = '100vh';
				this.panel.style.width = '100%';
			} else if (this.position === 'right') {
				this.panel.style.height = '100%';
				this.panel.style.width = '100vw';
			}
			this.maximizeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
		}
	}

	addTab(tab: Tab): void {
		this.tabs[tab.id] = tab;
		tab.originalIndex = this.nextTabOriginalIndex++;

		if (tab.allowDetach === false) {
			tab.button.classList.add('no-detach');
		}

		tab.onVisibilityChange = () => this.updatePanelSize();
		this.setupTabDragAndDrop(tab);

		if (!tab.builtin) {
			this.tabsContainer.appendChild(tab.button);
		}

		this.contentWrapper.appendChild(tab.content);

		if (!tab.isVisible) {
			tab.button.style.display = 'none';
			tab.content.style.display = 'none';
		}

		if (tab.builtin) {
			this.addBuiltinTab(tab);
		}

		this.updatePanelSize();
	}

	addBuiltinTab(tab: Tab): void {
		const builtinButton = document.createElement('button');
		builtinButton.className = 'builtin-tab-btn';

		if (tab.icon) {
			builtinButton.innerHTML = tab.icon;
		} else {
			builtinButton.textContent = tab.button.textContent!.charAt(0).toUpperCase();
		}
		builtinButton.title = tab.button.textContent!;

		const miniContent = document.createElement('div');
		miniContent.className = 'mini-panel-content';
		miniContent.style.display = 'none';

		tab.builtinButton = builtinButton;
		tab.miniContent = miniContent;
		this.miniPanel.appendChild(miniContent);

		builtinButton.onclick = (e) => {
			e.stopPropagation();
			const isCurrentlyActive = miniContent.style.display !== 'none' && miniContent.children.length > 0;

			this.miniPanel.querySelectorAll('.mini-panel-content').forEach(content => {
				(content as HTMLElement).style.display = 'none';
			});

			this.builtinTabsContainer.querySelectorAll('.builtin-tab-btn').forEach(btn => {
				btn.classList.remove('active');
			});

			if (isCurrentlyActive) {
				this.miniPanel.classList.remove('visible');
				miniContent.style.display = 'none';
			} else {
				builtinButton.classList.add('active');
				if (!miniContent.firstChild) {
					const actualContent = tab.content.querySelector('.list-scroll-wrapper') || tab.content.firstElementChild;
					if (actualContent) {
						miniContent.appendChild(actualContent);
					}
				}
				miniContent.style.display = 'block';
				this.miniPanel.classList.add('visible');
			}
		};

		this.builtinTabsContainer.appendChild(builtinButton);

		tab.builtinButton = builtinButton;
		tab.miniContent = miniContent;
		tab.profiler = this;

		if (!tab.isVisible) {
			builtinButton.style.display = 'none';
			miniContent.style.display = 'none';

			const hasVisibleBuiltinButtons = Array.from(this.builtinTabsContainer.querySelectorAll('.builtin-tab-btn'))
				.some(btn => (btn as HTMLElement).style.display !== 'none');

			if (!hasVisibleBuiltinButtons) {
				(this.builtinTabsContainer as HTMLElement).style.display = 'none';
			}
		}
	}

	updatePanelSize(): void {
		const hasVisibleTabs = Object.values(this.tabs).some(tab => !tab.isDetached && tab.isVisible);

		if (!hasVisibleTabs) {
			this.panel.classList.add('no-tabs');
			if (this.panel.classList.contains('maximized')) {
				this.panel.classList.remove('maximized');
				this.maximizeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
			}
			if (this.position === 'bottom') this.panel.style.height = '38px';
			else if (this.position === 'right') this.panel.style.width = '45px';
		} else {
			this.panel.classList.remove('no-tabs');
			if (Object.keys(this.tabs).length > 0) {
				if (this.position === 'bottom') {
					const currentHeight = parseInt(this.panel.style.height);
					if (currentHeight === 38) this.panel.style.height = `${this.lastHeightBottom}px`;
				} else if (this.position === 'right') {
					const currentWidth = parseInt(this.panel.style.width);
					if (currentWidth === 45) this.panel.style.width = `${this.lastWidthRight}px`;
				}
			}
		}
	}

	setupTabDragAndDrop(tab: Tab): void {
		if (this.isMobile) {
			tab.button.addEventListener('click', () => this.setActiveTab(tab.id));
			return;
		}

		if (tab.allowDetach === false) {
			tab.button.addEventListener('click', () => this.setActiveTab(tab.id));
			tab.button.style.cursor = 'default';
			return;
		}

		let isDragging = false;
		let startX = 0, startY = 0;
		let hasMoved = false;
		let previewWindow: HTMLDivElement | null = null;
		const dragThreshold = 10;

		const onDragStart = (e: PointerEvent) => {
			startX = e.clientX;
			startY = e.clientY;
			isDragging = false;
			hasMoved = false;
			tab.button.setPointerCapture(e.pointerId);
		};

		const onDragMove = (e: PointerEvent) => {
			const deltaX = Math.abs(e.clientX - startX);
			const deltaY = Math.abs(e.clientY - startY);

			if (!isDragging && (deltaX > dragThreshold || deltaY > dragThreshold)) {
				isDragging = true;
				tab.button.style.cursor = 'grabbing';
				tab.button.style.opacity = '0.5';
				tab.button.style.transform = 'scale(1.05)';
				previewWindow = this.createPreviewWindow(tab, e.clientX, e.clientY);
				previewWindow.style.opacity = '0.8';
			}

			if (isDragging && previewWindow) {
				hasMoved = true;
				e.preventDefault();
				previewWindow.style.left = `${e.clientX - 200}px`;
				previewWindow.style.top = `${e.clientY - 20}px`;
			}
		};

		const onDragEnd = () => {
			if (isDragging && hasMoved && previewWindow) {
				if (previewWindow.parentNode) previewWindow.parentNode.removeChild(previewWindow);
				const finalX = parseInt(previewWindow.style.left) + 200;
				const finalY = parseInt(previewWindow.style.top) + 20;
				this.detachTab(tab, finalX, finalY);
			} else if (!hasMoved) {
				this.setActiveTab(tab.id);
				if (previewWindow?.parentNode) previewWindow.parentNode.removeChild(previewWindow);
			} else if (previewWindow?.parentNode) {
				previewWindow.parentNode.removeChild(previewWindow);
			}

			tab.button.style.opacity = '';
			tab.button.style.transform = '';
			tab.button.style.cursor = '';
			isDragging = false;
			hasMoved = false;
			previewWindow = null;

			tab.button.removeEventListener('pointermove', onDragMove);
			tab.button.removeEventListener('pointerup', onDragEnd);
			tab.button.removeEventListener('pointercancel', onDragEnd);
		};

		tab.button.addEventListener('pointerdown', (e) => {
			onDragStart(e);
			tab.button.addEventListener('pointermove', onDragMove);
			tab.button.addEventListener('pointerup', onDragEnd);
			tab.button.addEventListener('pointercancel', onDragEnd);
		});

		tab.button.style.cursor = 'grab';
	}

	createPreviewWindow(tab: Tab, x: number, y: number): HTMLDivElement {
		const windowPanel = document.createElement('div');
		windowPanel.className = 'detached-tab-panel';
		windowPanel.style.left = `${x - 200}px`;
		windowPanel.style.top = `${y - 20}px`;
		windowPanel.style.pointerEvents = 'none';

		this.maxZIndex++;
		windowPanel.style.setProperty('z-index', String(this.maxZIndex), 'important');

		const windowHeader = document.createElement('div');
		windowHeader.className = 'detached-tab-header';

		const title = document.createElement('span');
		title.textContent = tab.button.textContent!.replace('⇱', '').trim();
		windowHeader.appendChild(title);

		const headerControls = document.createElement('div');
		headerControls.className = 'detached-header-controls';
		const reattachBtn = document.createElement('button');
		reattachBtn.className = 'detached-reattach-btn';
		reattachBtn.innerHTML = '↩';
		headerControls.appendChild(reattachBtn);
		windowHeader.appendChild(headerControls);

		const windowContent = document.createElement('div');
		windowContent.className = 'detached-tab-content';

		const resizer = document.createElement('div');
		resizer.className = 'detached-tab-resizer';

		windowPanel.appendChild(resizer);
		windowPanel.appendChild(windowHeader);
		windowPanel.appendChild(windowContent);

		document.body.appendChild(windowPanel);
		return windowPanel;
	}

	detachTab(tab: Tab, x: number, y: number): void {
		if (tab.isDetached || tab.allowDetach === false) return;

		const allButtons = Array.from(this.tabsContainer.children);
		const tabIdsInOrder = allButtons.map(btn =>
			Object.keys(this.tabs).find(id => this.tabs[id].button === btn)
		).filter((id): id is string => id !== undefined);

		const currentIndex = tabIdsInOrder.indexOf(tab.id);
		let newActiveTab: string | null = null;

		if (this.activeTabId === tab.id) {
			tab.setActive(false);
			const remainingTabs = tabIdsInOrder.filter(id => id !== tab.id && !this.tabs[id].isDetached && this.tabs[id].isVisible);

			if (remainingTabs.length > 0) {
				for (let i = currentIndex - 1; i >= 0; i--) {
					if (remainingTabs.includes(tabIdsInOrder[i])) { newActiveTab = tabIdsInOrder[i]; break; }
				}
				if (!newActiveTab) {
					for (let i = currentIndex + 1; i < tabIdsInOrder.length; i++) {
						if (remainingTabs.includes(tabIdsInOrder[i])) { newActiveTab = tabIdsInOrder[i]; break; }
					}
				}
				if (!newActiveTab) newActiveTab = remainingTabs[0];
			}
		}

		if (tab.button.parentNode) tab.button.parentNode.removeChild(tab.button);
		if (tab.content.parentNode) tab.content.parentNode.removeChild(tab.content);

		const detachedWindow = this.createDetachedWindow(tab, x, y);
		this.detachedWindows.push(detachedWindow);

		tab.isDetached = true;
		tab.detachedWindow = detachedWindow;

		if (newActiveTab) this.setActiveTab(newActiveTab);
		else if (this.activeTabId === tab.id) this.activeTabId = null;

		this.updatePanelSize();
		this.saveLayout();
	}

	createDetachedWindow(tab: Tab, x: number, y: number): DetachedWindow {
		const windowWidth = window.innerWidth;
		const windowHeight = window.innerHeight;
		const estimatedWidth = 400;
		const estimatedHeight = 300;

		let constrainedX = x - 200;
		let constrainedY = y - 20;

		if (constrainedX + estimatedWidth > windowWidth) constrainedX = windowWidth - estimatedWidth;
		if (constrainedX < 0) constrainedX = 0;
		if (constrainedY + estimatedHeight > windowHeight) constrainedY = windowHeight - estimatedHeight;
		if (constrainedY < 0) constrainedY = 0;

		const windowPanel = document.createElement('div');
		windowPanel.className = 'detached-tab-panel';
		windowPanel.style.left = `${constrainedX}px`;
		windowPanel.style.top = `${constrainedY}px`;

		if (!this.panel.classList.contains('visible')) {
			windowPanel.style.opacity = '0';
			windowPanel.style.visibility = 'hidden';
			windowPanel.style.pointerEvents = 'none';
		}

		if (!tab.isVisible) windowPanel.style.display = 'none';

		const windowHeader = document.createElement('div');
		windowHeader.className = 'detached-tab-header';

		const title = document.createElement('span');
		title.textContent = tab.button.textContent!.replace('⇱', '').trim();
		windowHeader.appendChild(title);

		const headerControls = document.createElement('div');
		headerControls.className = 'detached-header-controls';
		const reattachBtn = document.createElement('button');
		reattachBtn.className = 'detached-reattach-btn';
		reattachBtn.innerHTML = '↩';
		reattachBtn.title = 'Reattach to main panel';
		reattachBtn.onclick = () => this.reattachTab(tab);
		headerControls.appendChild(reattachBtn);
		windowHeader.appendChild(headerControls);

		const windowContent = document.createElement('div');
		windowContent.className = 'detached-tab-content';
		windowContent.appendChild(tab.content);

		tab.content.style.display = '';
		tab.content.classList.add('active');

		const resizerTop = document.createElement('div'); resizerTop.className = 'detached-tab-resizer-top';
		const resizerRight = document.createElement('div'); resizerRight.className = 'detached-tab-resizer-right';
		const resizerBottom = document.createElement('div'); resizerBottom.className = 'detached-tab-resizer-bottom';
		const resizerLeft = document.createElement('div'); resizerLeft.className = 'detached-tab-resizer-left';
		const resizerCorner = document.createElement('div'); resizerCorner.className = 'detached-tab-resizer';

		windowPanel.appendChild(resizerTop);
		windowPanel.appendChild(resizerRight);
		windowPanel.appendChild(resizerBottom);
		windowPanel.appendChild(resizerLeft);
		windowPanel.appendChild(resizerCorner);
		windowPanel.appendChild(windowHeader);
		windowPanel.appendChild(windowContent);

		document.body.appendChild(windowPanel);

		this.setupDetachedWindowDrag(windowPanel, windowHeader, tab);
		this.setupDetachedWindowResize(windowPanel, resizerTop, resizerRight, resizerBottom, resizerLeft, resizerCorner);

		windowPanel.style.setProperty('z-index', String(this.maxZIndex), 'important');

		return { panel: windowPanel, tab };
	}

	bringWindowToFront(windowPanel: HTMLDivElement): void {
		this.maxZIndex++;
		windowPanel.style.setProperty('z-index', String(this.maxZIndex), 'important');
	}

	setupDetachedWindowDrag(windowPanel: HTMLDivElement, header: HTMLDivElement, tab: Tab): void {
		let isDragging = false;
		let startX = 0, startY = 0, startLeft = 0, startTop = 0;

		windowPanel.addEventListener('pointerdown', () => this.bringWindowToFront(windowPanel));

		const onDragStart = (e: PointerEvent) => {
			if ((e.target as HTMLElement).classList.contains('detached-reattach-btn')) return;
			this.bringWindowToFront(windowPanel);
			isDragging = true;
			header.style.cursor = 'grabbing';
			header.setPointerCapture(e.pointerId);
			startX = e.clientX;
			startY = e.clientY;
			const rect = windowPanel.getBoundingClientRect();
			startLeft = rect.left;
			startTop = rect.top;
		};

		const onDragMove = (e: PointerEvent) => {
			if (!isDragging) return;
			e.preventDefault();
			const deltaX = e.clientX - startX;
			const deltaY = e.clientY - startY;
			let newLeft = startLeft + deltaX;
			let newTop = startTop + deltaY;

			const ww = window.innerWidth, wh = window.innerHeight;
			const pw = windowPanel.offsetWidth, ph = windowPanel.offsetHeight;
			const hw = pw / 2, hh = ph / 2;

			if (newLeft + pw > ww + hw) newLeft = ww + hw - pw;
			if (newLeft < -hw) newLeft = -hw;
			if (newTop + ph > wh + hh) newTop = wh + hh - ph;
			if (newTop < -hh) newTop = -hh;

			windowPanel.style.left = `${newLeft}px`;
			windowPanel.style.top = `${newTop}px`;

			const panelRect = this.panel.getBoundingClientRect();
			const isOverPanel = e.clientX >= panelRect.left && e.clientX <= panelRect.right &&
				e.clientY >= panelRect.top && e.clientY <= panelRect.bottom;

			windowPanel.style.opacity = isOverPanel ? '0.5' : '';
			this.panel.style.outline = isOverPanel ? '2px solid var(--accent-color)' : '';
		};

		const onDragEnd = (e: PointerEvent) => {
			if (!isDragging) return;
			isDragging = false;
			header.style.cursor = '';
			windowPanel.style.opacity = '';
			this.panel.style.outline = '';

			if (e.clientX !== undefined && e.clientY !== undefined) {
				const panelRect = this.panel.getBoundingClientRect();
				const isOverPanel = e.clientX >= panelRect.left && e.clientX <= panelRect.right &&
					e.clientY >= panelRect.top && e.clientY <= panelRect.bottom;
				if (isOverPanel && tab) this.reattachTab(tab);
				else this.saveLayout();
			}

			header.removeEventListener('pointermove', onDragMove);
			header.removeEventListener('pointerup', onDragEnd);
			header.removeEventListener('pointercancel', onDragEnd);
		};

		header.addEventListener('pointerdown', (e) => {
			onDragStart(e);
			header.addEventListener('pointermove', onDragMove);
			header.addEventListener('pointerup', onDragEnd);
			header.addEventListener('pointercancel', onDragEnd);
		});

		header.style.cursor = 'grab';
	}

	setupDetachedWindowResize(windowPanel: HTMLDivElement, resizerTop: HTMLDivElement, resizerRight: HTMLDivElement, resizerBottom: HTMLDivElement, resizerLeft: HTMLDivElement, resizerCorner: HTMLDivElement): void {
		const minWidth = 250;
		const minHeight = 150;

		const setupResizer = (resizer: HTMLDivElement, direction: string) => {
			let isResizing = false;
			let startX = 0, startY = 0, startWidth = 0, startHeight = 0, startLeft = 0, startTop = 0;

			const onResizeStart = (e: PointerEvent) => {
				e.preventDefault();
				e.stopPropagation();
				isResizing = true;
				this.bringWindowToFront(windowPanel);
				resizer.setPointerCapture(e.pointerId);
				startX = e.clientX; startY = e.clientY;
				startWidth = windowPanel.offsetWidth; startHeight = windowPanel.offsetHeight;
				startLeft = windowPanel.offsetLeft; startTop = windowPanel.offsetTop;
			};

			const onResizeMove = (e: PointerEvent) => {
				if (!isResizing) return;
				e.preventDefault();
				const deltaX = e.clientX - startX;
				const deltaY = e.clientY - startY;
				const ww = window.innerWidth, wh = window.innerHeight;

				if (direction === 'right' || direction === 'corner') {
					const newWidth = startWidth + deltaX;
					if (newWidth >= minWidth && newWidth <= ww - startLeft) windowPanel.style.width = `${newWidth}px`;
				}
				if (direction === 'bottom' || direction === 'corner') {
					const newHeight = startHeight + deltaY;
					if (newHeight >= minHeight && newHeight <= wh - startTop) windowPanel.style.height = `${newHeight}px`;
				}
				if (direction === 'left') {
					const newWidth = startWidth - deltaX;
					if (newWidth >= minWidth) {
						const newLeft = startLeft + deltaX;
						if (newLeft >= 0 && newLeft <= startLeft + startWidth - minWidth) {
							windowPanel.style.width = `${newWidth}px`;
							windowPanel.style.left = `${newLeft}px`;
						}
					}
				}
				if (direction === 'top') {
					const newHeight = startHeight - deltaY;
					if (newHeight >= minHeight) {
						const newTop = startTop + deltaY;
						if (newTop >= 0 && newTop <= startTop + startHeight - minHeight) {
							windowPanel.style.height = `${newHeight}px`;
							windowPanel.style.top = `${newTop}px`;
						}
					}
				}
			};

			const onResizeEnd = () => {
				isResizing = false;
				resizer.removeEventListener('pointermove', onResizeMove);
				resizer.removeEventListener('pointerup', onResizeEnd);
				resizer.removeEventListener('pointercancel', onResizeEnd);
				this.saveLayout();
			};

			resizer.addEventListener('pointerdown', (e) => {
				onResizeStart(e);
				resizer.addEventListener('pointermove', onResizeMove);
				resizer.addEventListener('pointerup', onResizeEnd);
				resizer.addEventListener('pointercancel', onResizeEnd);
			});
		};

		setupResizer(resizerTop, 'top');
		setupResizer(resizerRight, 'right');
		setupResizer(resizerBottom, 'bottom');
		setupResizer(resizerLeft, 'left');
		setupResizer(resizerCorner, 'corner');
	}

	reattachTab(tab: Tab): void {
		if (!tab.isDetached) return;

		if (tab.detachedWindow) {
			const index = this.detachedWindows.indexOf(tab.detachedWindow);
			if (index > -1) this.detachedWindows.splice(index, 1);
			if (tab.detachedWindow.panel.parentNode) tab.detachedWindow.panel.parentNode.removeChild(tab.detachedWindow.panel);
			tab.detachedWindow = null;
		}

		tab.isDetached = false;

		const allTabsSorted = Object.values(this.tabs)
			.filter(t => t.originalIndex !== undefined && t.isVisible)
			.sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0));

		const currentButtons = Array.from(this.tabsContainer.children);
		let insertIndex = 0;
		for (const t of allTabsSorted) {
			if (t.id === tab.id) break;
			if (!t.isDetached) insertIndex++;
		}

		if (insertIndex >= currentButtons.length || currentButtons.length === 0) {
			this.tabsContainer.appendChild(tab.button);
		} else {
			this.tabsContainer.insertBefore(tab.button, currentButtons[insertIndex]);
		}

		this.contentWrapper.appendChild(tab.content);
		tab.content.style.display = '';
		this.setActiveTab(tab.id);
		this.updatePanelSize();
		this.saveLayout();
	}

	setActiveTab(id: string): void {
		if (this.activeTabId && this.tabs[this.activeTabId] && !this.tabs[this.activeTabId].isDetached) {
			this.tabs[this.activeTabId].setActive(false);
		}
		this.activeTabId = id;
		if (this.tabs[id]) this.tabs[id].setActive(true);
		this.saveLayout();
	}

	togglePanel(): void {
		this.panel.classList.toggle('visible');
		this.toggleButton.classList.toggle('panel-open');
		this.miniPanel.classList.toggle('panel-open');

		const isVisible = this.panel.classList.contains('visible');

		this.detachedWindows.forEach(dw => {
			if (isVisible) {
				dw.panel.style.opacity = '';
				dw.panel.style.visibility = '';
				dw.panel.style.pointerEvents = '';
			} else {
				dw.panel.style.opacity = '0';
				dw.panel.style.visibility = 'hidden';
				dw.panel.style.pointerEvents = 'none';
			}
		});

		this.saveLayout();
	}

	togglePosition(): void {
		this.setPosition(this.position === 'bottom' ? 'right' : 'bottom');
	}

	setPosition(targetPosition: string): void {
		if (this.position === targetPosition) return;
		this.panel.style.transition = 'none';
		const isMaximized = this.panel.classList.contains('maximized');

		if (targetPosition === 'right') {
			this.position = 'right';
			this.floatingBtn.classList.add('active');
			this.floatingBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M3 15h18"></path></svg>';
			this.floatingBtn.title = 'Switch to Bottom';
			this.panel.classList.remove('position-bottom');
			this.panel.classList.add('position-right');
			this.panel.style.bottom = ''; this.panel.style.top = '0';
			this.panel.style.right = '0'; this.panel.style.left = '';
			this.panel.style.width = isMaximized ? '100vw' : `${this.lastWidthRight}px`;
			this.panel.style.height = '100%';
		} else {
			this.position = 'bottom';
			this.floatingBtn.classList.remove('active');
			this.floatingBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line></svg>';
			this.floatingBtn.title = 'Switch to Right Side';
			this.panel.classList.remove('position-right');
			this.panel.classList.add('position-bottom');
			this.panel.style.top = ''; this.panel.style.right = '';
			this.panel.style.bottom = '0'; this.panel.style.left = '0';
			this.panel.style.width = '100%';
			this.panel.style.height = isMaximized ? '100vh' : `${this.lastHeightBottom}px`;
		}

		setTimeout(() => { this.panel.style.transition = ''; }, 50);
		this.updatePanelSize();
		this.saveLayout();
	}

	saveLayout(): void {
		if (this.isLoadingLayout) return;

		const layout: LayoutData = {
			position: this.position,
			lastHeightBottom: this.lastHeightBottom,
			lastWidthRight: this.lastWidthRight,
			activeTabId: this.activeTabId,
			detachedTabs: [],
			isVisible: this.panel.classList.contains('visible'),
		};

		this.detachedWindows.forEach(dw => {
			const { panel: p, tab } = dw;
			layout.detachedTabs.push({
				tabId: tab.id,
				originalIndex: tab.originalIndex ?? 0,
				left: parseFloat(p.style.left) || p.offsetLeft || 0,
				top: parseFloat(p.style.top) || p.offsetTop || 0,
				width: p.offsetWidth,
				height: p.offsetHeight,
			});
		});

		try {
			const savedData = localStorage.getItem('gpucat-inspector');
			const data = JSON.parse(savedData || '{}');
			data.layout = layout;
			localStorage.setItem('gpucat-inspector', JSON.stringify(data));
		} catch (e) {
			console.warn('Failed to save profiler layout:', e);
		}
	}

	loadLayout(): void {
		this.isLoadingLayout = true;
		try {
			const savedData = localStorage.getItem('gpucat-inspector');
			if (!savedData) return;
			const parsedData = JSON.parse(savedData);
			const layout: LayoutData = parsedData.layout;
			if (!layout) return;

			if (layout.detachedTabs?.length > 0) {
				const ww = window.innerWidth, wh = window.innerHeight;
				layout.detachedTabs = layout.detachedTabs.map(d => {
					let { left, top, width, height } = d;
					if (width > ww) width = ww - 100;
					if (height > wh) height = wh - 100;
					const hw = width / 2, hh = height / 2;
					if (left + width > ww + hw) left = ww + hw - width;
					if (left < -hw) left = -hw;
					if (top + height > wh + hh) top = wh + hh - height;
					if (top < -hh) top = -hh;
					return { ...d, left, top, width, height };
				});
			}

			if (layout.position) this.position = layout.position;
			if (layout.lastHeightBottom) this.lastHeightBottom = layout.lastHeightBottom;
			if (layout.lastWidthRight) this.lastWidthRight = layout.lastWidthRight;

			const ww = window.innerWidth, wh = window.innerHeight;
			if (this.lastHeightBottom > wh - 50) this.lastHeightBottom = wh - 50;
			if (this.lastWidthRight > ww - 50) this.lastWidthRight = ww - 50;

			if (this.position === 'right') {
				this.floatingBtn.classList.add('active');
				this.floatingBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M3 15h18"></path></svg>';
				this.floatingBtn.title = 'Switch to Bottom';
				this.panel.classList.remove('position-bottom');
				this.panel.classList.add('position-right');
				this.panel.style.bottom = ''; this.panel.style.top = '0';
				this.panel.style.right = '0'; this.panel.style.left = '';
				this.panel.style.width = `${this.lastWidthRight}px`;
				this.panel.style.height = '100%';
			} else {
				this.panel.style.height = `${this.lastHeightBottom}px`;
			}

			if (layout.isVisible) {
				this.panel.classList.add('visible');
				this.toggleButton.classList.add('panel-open');
			}

			if (layout.activeTabId) this.setActiveTab(layout.activeTabId);

			if (layout.detachedTabs?.length > 0) {
				this.pendingDetachedTabs = layout.detachedTabs;
				this.restoreDetachedTabs();
			}

			this.updatePanelSize();

			if (this.panel.classList.contains('visible')) {
				this.miniPanel.classList.add('panel-open');
			}
		} catch (e) {
			console.warn('Failed to load profiler layout:', e);
		} finally {
			this.isLoadingLayout = false;
		}
	}

	restoreDetachedTabs(): void {
		if (!this.pendingDetachedTabs?.length) return;

		this.pendingDetachedTabs.forEach(d => {
			const tab = this.tabs[d.tabId];
			if (!tab || tab.isDetached) return;
			if (d.originalIndex !== undefined) tab.originalIndex = d.originalIndex;

			if (tab.button.parentNode) tab.button.parentNode.removeChild(tab.button);
			if (tab.content.parentNode) tab.content.parentNode.removeChild(tab.content);

			const dw = this.createDetachedWindow(tab, 0, 0);
			dw.panel.style.left = `${d.left}px`;
			dw.panel.style.top = `${d.top}px`;
			dw.panel.style.width = `${d.width}px`;
			dw.panel.style.height = `${d.height}px`;
			this.constrainWindowToBounds(dw.panel);

			this.detachedWindows.push(dw);
			tab.isDetached = true;
			tab.detachedWindow = dw;
		});

		this.pendingDetachedTabs = null;

		this.detachedWindows.forEach(dw => {
			const z = parseInt(getComputedStyle(dw.panel).zIndex) || 0;
			if (z > this.maxZIndex) this.maxZIndex = z;
		});

		const needsNewActiveTab = !this.activeTabId || !this.tabs[this.activeTabId] ||
			this.tabs[this.activeTabId].isDetached || !this.tabs[this.activeTabId].isVisible;

		if (needsNewActiveTab) {
			const available = Object.keys(this.tabs).filter(id => !this.tabs[id].isDetached && this.tabs[id].isVisible);
			if (available.length > 0) {
				const buttons = Array.from(this.tabsContainer.children);
				const ordered = buttons.map(btn => Object.keys(this.tabs).find(id => this.tabs[id].button === btn))
					.filter((id): id is string => id !== undefined && !this.tabs[id].isDetached && this.tabs[id].isVisible);
				this.setActiveTab(ordered[0] || available[0]);
			} else {
				this.activeTabId = null;
			}
		}

		this.updatePanelSize();
	}
}
