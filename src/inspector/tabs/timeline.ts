import { Tab } from '../ui/tab';
import { Graph } from '../ui/graph';

const LIMIT = 500;

type TimelineFrame = { id: string; calls: Array<{ method: string }>; fps: number };

export class Timeline extends Tab {

    isRecording = false;
    frames: TimelineFrame[] = [];
    currentFrame: TimelineFrame | null = null;
    isHierarchicalView = true;

    graph: Graph;
    graphSlider!: HTMLDivElement;
    hoverIndicator!: HTMLDivElement;
    playhead!: HTMLDivElement;
    timelineTrack!: HTMLDivElement;
    recordButton!: HTMLButtonElement;
    recordRefreshButton!: HTMLButtonElement;
    viewModeButton!: HTMLButtonElement;
    frameInfo!: HTMLSpanElement;
    collapsedGroups?: Set<string>;

    selectedFrameIndex = -1;
    isTrackingLatest = true;
    isManualScrubbing = false;
    fixedScreenX = 0;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Timeline', options);

        this.graph = new Graph(LIMIT);
        this.graph.addLine('fps', 'var(--color-fps)');
        this.graph.addLine('calls', 'var(--color-call)');

        this._buildHeader();
        this._buildUI();

        window.addEventListener('resize', () => {
            if (!this.isRecording && this.frames.length > 0) {
                this.renderSlider();
            }
        });
    }

    private _buildHeader(): void {
        const header = document.createElement('div');
        header.className = 'console-header';

        this.recordButton = document.createElement('button');
        this.recordButton.className = 'console-copy-button';
        this.recordButton.title = 'Record';
        this.recordButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4" fill="currentColor"></circle></svg>';
        this.recordButton.style.padding = '0 10px';
        this.recordButton.style.lineHeight = '24px';
        this.recordButton.style.display = 'flex';
        this.recordButton.style.alignItems = 'center';
        this.recordButton.addEventListener('click', () => this.toggleRecording());

        const clearButton = document.createElement('button');
        clearButton.className = 'console-copy-button';
        clearButton.title = 'Clear';
        clearButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
        clearButton.style.padding = '0 10px';
        clearButton.style.lineHeight = '24px';
        clearButton.style.display = 'flex';
        clearButton.style.alignItems = 'center';
        clearButton.addEventListener('click', () => this.clear());

        this.viewModeButton = document.createElement('button');
        this.viewModeButton.className = 'console-copy-button';
        this.viewModeButton.title = 'Toggle View Mode';
        this.viewModeButton.textContent = 'Mode: Hierarchy';
        this.viewModeButton.style.padding = '0 10px';
        this.viewModeButton.style.lineHeight = '24px';
        this.viewModeButton.addEventListener('click', () => {
            this.isHierarchicalView = !this.isHierarchicalView;
            this.viewModeButton.textContent = this.isHierarchicalView ? 'Mode: Hierarchy' : 'Mode: Counts';
            if (this.selectedFrameIndex !== undefined && this.selectedFrameIndex !== -1) {
                this.selectFrame(this.selectedFrameIndex);
            }
        });

        this.recordRefreshButton = document.createElement('button');
        this.recordRefreshButton.className = 'console-copy-button';
        this.recordRefreshButton.title = 'Refresh & Record';
        this.recordRefreshButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><circle cx="12" cy="12" r="3" fill="currentColor"></circle></svg>';
        this.recordRefreshButton.style.padding = '0 10px';
        this.recordRefreshButton.style.lineHeight = '24px';
        this.recordRefreshButton.style.display = 'flex';
        this.recordRefreshButton.style.alignItems = 'center';
        this.recordRefreshButton.addEventListener('click', () => {
            const storage = JSON.parse(localStorage.getItem('gpucat-inspector') || '{}');
            storage.timeline = storage.timeline || {};
            storage.timeline.recording = true;
            localStorage.setItem('gpucat-inspector', JSON.stringify(storage));
            window.location.reload();
        });

        const buttonsGroup = document.createElement('div');
        buttonsGroup.className = 'console-buttons-group';
        buttonsGroup.appendChild(this.viewModeButton);
        buttonsGroup.appendChild(this.recordButton);
        buttonsGroup.appendChild(this.recordRefreshButton);
        buttonsGroup.appendChild(clearButton);

        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.padding = '6px';
        header.style.borderBottom = '1px solid var(--border-color)';

        const titleElement = document.createElement('div');
        titleElement.textContent = 'Backend Calls Timeline';
        titleElement.style.color = 'var(--text-primary)';
        titleElement.style.alignSelf = 'center';
        titleElement.style.paddingLeft = '5px';

        this.frameInfo = document.createElement('span');
        this.frameInfo.style.marginLeft = '15px';
        this.frameInfo.style.fontFamily = 'monospace';
        this.frameInfo.style.color = 'var(--text-secondary)';
        this.frameInfo.style.fontSize = '12px';
        titleElement.appendChild(this.frameInfo);

        header.appendChild(titleElement);
        header.appendChild(buttonsGroup);
        this.content.appendChild(header);
    }

    private _buildUI(): void {
        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.height = 'calc(100% - 37px)';
        container.style.width = '100%';

        const graphContainer = document.createElement('div');
        graphContainer.style.height = '60px';
        graphContainer.style.minHeight = '60px';
        graphContainer.style.borderBottom = '1px solid var(--border-color)';
        graphContainer.style.backgroundColor = 'var(--background-color)';

        this.graphSlider = document.createElement('div');
        this.graphSlider.style.height = '100%';
        this.graphSlider.style.margin = '0 10px';
        this.graphSlider.style.position = 'relative';
        this.graphSlider.style.cursor = 'crosshair';

        graphContainer.appendChild(this.graphSlider);

        this.graph.domElement.style.width = '100%';
        this.graph.domElement.style.height = '100%';
        this.graphSlider.appendChild(this.graph.domElement);

        this.hoverIndicator = document.createElement('div');
        this.hoverIndicator.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.3);pointer-events:none;display:none;z-index:9;transform:translateX(-50%)';
        this.graphSlider.appendChild(this.hoverIndicator);

        this.playhead = document.createElement('div');
        this.playhead.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;background:var(--color-red);box-shadow:0 0 4px rgba(255,0,0,0.5);pointer-events:none;display:none;z-index:10;transform:translateX(-50%)';
        const playheadHandle = document.createElement('div');
        playheadHandle.style.cssText = 'position:absolute;top:0;left:50%;transform:translate(-50%,0);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid var(--color-red)';
        this.playhead.appendChild(playheadHandle);
        this.graphSlider.appendChild(this.playhead);

        this.graphSlider.tabIndex = 0;
        this.graphSlider.style.outline = 'none';

        let isDragging = false;

        const updatePlayheadFromEvent = (e: MouseEvent) => {
            if (this.frames.length === 0) return;
            const rect = this.graphSlider.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(x, rect.width));
            this.fixedScreenX = x;

            const pointCount = this.graph.lines['calls'].points.length;
            if (pointCount === 0) return;

            const pointStep = rect.width / (this.graph.maxPoints - 1);
            const offset = rect.width - ((pointCount - 1) * pointStep);
            let localFrameIndex = Math.round((x - offset) / pointStep);
            localFrameIndex = Math.max(0, Math.min(localFrameIndex, pointCount - 1));

            this.isTrackingLatest = localFrameIndex >= pointCount - 2;

            let frameIndex = localFrameIndex;
            if (this.frames.length > pointCount) frameIndex += this.frames.length - pointCount;

            this.playhead.style.display = 'block';
            this.selectFrame(frameIndex);
        };

        this.graphSlider.addEventListener('mousedown', (e) => {
            isDragging = true;
            this.isManualScrubbing = true;
            this.graphSlider.focus();
            updatePlayheadFromEvent(e);
        });

        this.graphSlider.addEventListener('mouseenter', () => {
            if (this.frames.length > 0 && !this.isRecording) {
                this.hoverIndicator.style.display = 'block';
            }
        });

        this.graphSlider.addEventListener('mouseleave', () => {
            this.hoverIndicator.style.display = 'none';
        });

        this.graphSlider.addEventListener('mousemove', (e) => {
            if (this.frames.length === 0 || this.isRecording) return;
            const rect = this.graphSlider.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(x, rect.width));

            const pointCount = this.graph.lines['calls'].points.length;
            if (pointCount > 0) {
                const pointStep = rect.width / (this.graph.maxPoints - 1);
                const offset = rect.width - ((pointCount - 1) * pointStep);
                let localFrameIndex = Math.round((x - offset) / pointStep);
                localFrameIndex = Math.max(0, Math.min(localFrameIndex, pointCount - 1));
                let snappedX = offset + localFrameIndex * pointStep;
                snappedX = Math.max(1, Math.min(snappedX, rect.width - 1));
                this.hoverIndicator.style.left = snappedX + 'px';
            } else {
                this.hoverIndicator.style.left = Math.max(1, Math.min(x, rect.width - 1)) + 'px';
            }
        });

        this.graphSlider.addEventListener('keydown', (e) => {
            if (this.frames.length === 0 || this.isRecording) return;
            let newIndex = this.selectedFrameIndex;
            if (e.key === 'ArrowLeft') { newIndex = Math.max(0, this.selectedFrameIndex - 1); e.preventDefault(); }
            else if (e.key === 'ArrowRight') { newIndex = Math.min(this.frames.length - 1, this.selectedFrameIndex + 1); e.preventDefault(); }

            if (newIndex !== this.selectedFrameIndex) {
                this.selectFrame(newIndex);
                const pointCount = this.graph.lines['calls'].points.length;
                if (pointCount > 0) {
                    let localIndex = newIndex;
                    if (this.frames.length > pointCount) localIndex = newIndex - (this.frames.length - pointCount);
                    this.isTrackingLatest = localIndex >= pointCount - 2;
                    const rect = this.graphSlider.getBoundingClientRect();
                    const pointStep = rect.width / (this.graph.maxPoints - 1);
                    const offset = rect.width - ((pointCount - 1) * pointStep);
                    this.fixedScreenX = offset + localIndex * pointStep;
                }
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            updatePlayheadFromEvent(e);
            const rect = this.graphSlider.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(x, rect.width));
            const pointCount = this.graph.lines['calls'].points.length;
            if (pointCount > 0) {
                const pointStep = rect.width / (this.graph.maxPoints - 1);
                const offset = rect.width - ((pointCount - 1) * pointStep);
                let localFrameIndex = Math.round((x - offset) / pointStep);
                localFrameIndex = Math.max(0, Math.min(localFrameIndex, pointCount - 1));
                let snappedX = offset + localFrameIndex * pointStep;
                snappedX = Math.max(1, Math.min(snappedX, rect.width - 1));
                this.hoverIndicator.style.left = snappedX + 'px';
            } else {
                this.hoverIndicator.style.left = Math.max(1, Math.min(x, rect.width - 1)) + 'px';
            }
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
            this.isManualScrubbing = false;
        });

        container.appendChild(graphContainer);

        const mainArea = document.createElement('div');
        mainArea.style.flex = '1';
        mainArea.style.display = 'flex';
        mainArea.style.flexDirection = 'column';
        mainArea.style.overflow = 'hidden';

        this.timelineTrack = document.createElement('div');
        this.timelineTrack.style.flex = '1';
        this.timelineTrack.style.overflowY = 'auto';
        this.timelineTrack.style.margin = '10px';
        this.timelineTrack.style.backgroundColor = 'var(--background-color)';
        mainArea.appendChild(this.timelineTrack);

        container.appendChild(mainArea);
        this.content.appendChild(container);
    }

    /** Called by Inspector.ts to set up auto-start from localStorage. */
    setRenderer(_renderer: unknown): void {
        const storage = JSON.parse(localStorage.getItem('gpucat-inspector') || '{}');
        if (storage.timeline?.recording) {
            storage.timeline.recording = false;
            localStorage.setItem('gpucat-inspector', JSON.stringify(storage));
            this.toggleRecording();
        }
    }

    toggleRecording(): void {
        this.isRecording = !this.isRecording;

        if (this.isRecording) {
            this.recordButton.title = 'Stop';
            this.recordButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
            this.recordButton.style.color = 'var(--color-red)';
            this.startRecording();
        } else {
            this.recordButton.title = 'Record';
            this.recordButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4" fill="currentColor"></circle></svg>';
            this.recordButton.style.color = '';
            this.stopRecording();
            this.renderSlider();
        }
    }

    startRecording(): void {
        this.frames = [];
        this.currentFrame = null;
        this.selectedFrameIndex = -1;
        this.fixedScreenX = 0;
        this.isTrackingLatest = true;
        this.isManualScrubbing = false;
        this.clear();
        this.frameInfo.textContent = 'Recording...';
        // Actual call interception is done by Inspector overriding begin/beginRender/etc.
        // and calling timeline.onCall(method, label).
    }

    stopRecording(): void {
        // Nothing to undo — no monkey-patching happened.
        if (this.currentFrame) {
            // mark fps from outside
        }
    }

    /**
     * Called by Inspector when a new frame begins or a pass/compute begins/ends.
     * `method` is e.g. 'begin', 'beginRender', 'finishRender', 'beginCompute', 'finishCompute'.
     * `label` is e.g. the frameId string or a passId.
     */
    onCall(method: string, label: string, fps = 0): void {
        if (!this.isRecording) return;

        if (method === 'begin') {
            // A new frame started — seal the previous frame
            if (this.currentFrame) {
                this.currentFrame.fps = fps;
                if (!isFinite(this.currentFrame.fps)) this.currentFrame.fps = 0;
                this.graph.addPoint('calls', this.currentFrame.calls.length);
                this.graph.addPoint('fps', this.currentFrame.fps);
                this.graph.update();
            }

            this.currentFrame = { id: label, calls: [], fps: 0 };
            this.frames.push(this.currentFrame);

            if (this.frames.length > LIMIT) this.frames.shift();

            if (!this.isManualScrubbing) {
                if (this.isTrackingLatest) {
                    const targetIndex = this.frames.length > 1 ? this.frames.length - 2 : 0;
                    this.selectFrame(targetIndex);
                } else if (this.selectedFrameIndex !== -1) {
                    const pointCount = this.graph.lines['calls'].points.length;
                    if (pointCount > 0) {
                        const rect = this.graphSlider.getBoundingClientRect();
                        const pointStep = rect.width / (this.graph.maxPoints - 1);
                        const offset = rect.width - ((pointCount - 1) * pointStep);
                        let localFrameIndex = Math.round((this.fixedScreenX - offset) / pointStep);
                        localFrameIndex = Math.max(0, Math.min(localFrameIndex, pointCount - 1));
                        let newFrameIndex = localFrameIndex;
                        if (this.frames.length > pointCount) newFrameIndex += this.frames.length - pointCount;
                        this.selectFrame(newFrameIndex);
                    }
                }
            }
            return;
        }

        if (!this.currentFrame) return;
        this.currentFrame.calls.push({ method: label ? `${method} - ${label}` : method });
    }

    clear(): void {
        this.frames = [];
        this.timelineTrack.innerHTML = '';
        this.playhead.style.display = 'none';
        this.frameInfo.textContent = '';
        this.graph.lines['calls'].points = [];
        this.graph.lines['fps'].points = [];
        this.graph.resetLimit();
        this.graph.update();
    }

    renderSlider(): void {
        if (this.frames.length === 0) {
            this.playhead.style.display = 'none';
            this.frameInfo.textContent = '';
            return;
        }

        this.graph.lines['calls'].points = [];
        this.graph.lines['fps'].points = [];
        this.graph.resetLimit();

        let framesToRender = this.frames;
        if (framesToRender.length > this.graph.maxPoints) {
            framesToRender = framesToRender.slice(-this.graph.maxPoints);
            this.frames = framesToRender;
        }

        for (let i = 0; i < framesToRender.length; i++) {
            this.graph.addPoint('calls', framesToRender[i].calls.length);
            this.graph.addPoint('fps', framesToRender[i].fps || 0);
        }

        this.graph.update();
        this.playhead.style.display = 'block';

        let targetFrame = 0;
        if (this.selectedFrameIndex !== -1 && this.selectedFrameIndex < this.frames.length) {
            targetFrame = this.selectedFrameIndex;
        } else if (this.frames.length > 0) {
            targetFrame = this.frames.length - 1;
        }

        this.selectFrame(targetFrame);
    }

    selectFrame(index: number): void {
        if (index < 0 || index >= this.frames.length) return;
        this.selectedFrameIndex = index;
        const frame = this.frames[index];
        this.renderTimelineTrack(frame);

        this.frameInfo.textContent = `Frame: ${frame.id} [${frame.calls.length} calls] [${(frame.fps || 0).toFixed(1)} FPS]`;

        const rect = this.graphSlider.getBoundingClientRect();
        const pointCount = this.graph.lines['calls'].points.length;

        if (pointCount > 0) {
            const pointStep = rect.width / (this.graph.maxPoints - 1);
            let localIndex = index;
            if (this.frames.length > pointCount) localIndex = index - (this.frames.length - pointCount);
            const offset = rect.width - ((pointCount - 1) * pointStep);
            let xPos = offset + (localIndex * pointStep);
            xPos = Math.max(1, Math.min(xPos, rect.width - 1));
            this.playhead.style.left = xPos + 'px';
            this.playhead.style.display = 'block';
        }
    }

    renderTimelineTrack(frame: TimelineFrame): void {
        this.timelineTrack.innerHTML = '';
        if (!frame || frame.calls.length === 0) return;

        if (!this.collapsedGroups) this.collapsedGroups = new Set();

        const frag = document.createDocumentFragment();

        if (this.isHierarchicalView) {
            type GroupedCall = { method: string; count: number };
            const groupedCalls: GroupedCall[] = [];
            let currentGroup: GroupedCall | null = null;

            for (const call of frame.calls) {
                const isStructural = call.method.startsWith('begin') || call.method.startsWith('finish');
                if (currentGroup && currentGroup.method === call.method && !isStructural) {
                    currentGroup.count++;
                } else {
                    currentGroup = { method: call.method, count: 1 };
                    groupedCalls.push(currentGroup);
                }
            }

            let currentIndent = 0;
            const indentSize = 24;
            const elementStack: Array<{ element: DocumentFragment | HTMLElement; isCollapsed: boolean; id: string }> = [
                { element: frag, isCollapsed: false, id: '' }
            ];

            for (let i = 0; i < groupedCalls.length; i++) {
                const call = groupedCalls[i];
                const block = document.createElement('div');
                block.style.cssText = `padding:4px 8px;margin:2px 0;margin-left:${currentIndent * indentSize}px;border-left:4px solid ${this._getColorForMethod(call.method)};background:rgba(255,255,255,0.03);font-family:monospace;font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center`;

                const currentParent = elementStack[elementStack.length - 1];
                if (!currentParent.isCollapsed) frag.appendChild(block);

                if (call.method.startsWith('begin')) {
                    const groupId = currentParent.id + '/' + call.method + '-' + i;
                    const isCollapsed = this.collapsedGroups.has(groupId);

                    const arrow = document.createElement('span');
                    arrow.textContent = isCollapsed ? '[ + ]' : '[ - ]';
                    arrow.style.cssText = 'font-size:10px;margin-right:10px;cursor:pointer;width:26px;display:inline-block;text-align:center';
                    block.appendChild(arrow);
                    block.style.cursor = 'pointer';

                    const title = document.createElement('span');
                    title.textContent = call.method + (call.count > 1 ? ` ( ${call.count} )` : '');
                    block.appendChild(title);

                    block.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (isCollapsed) this.collapsedGroups!.delete(groupId);
                        else this.collapsedGroups!.add(groupId);
                        this.renderTimelineTrack(this.frames[this.selectedFrameIndex]);
                    });

                    currentIndent++;
                    elementStack.push({ element: block, isCollapsed: currentParent.isCollapsed || isCollapsed, id: groupId });
                } else if (call.method.startsWith('finish')) {
                    block.textContent = call.method + (call.count > 1 ? ` ( ${call.count} )` : '');
                    currentIndent = Math.max(0, currentIndent - 1);
                    elementStack.pop();
                } else {
                    block.textContent = call.method + (call.count > 1 ? ` ( ${call.count} )` : '');
                }
            }
        } else {
            const callCounts: Record<string, number> = {};
            for (const call of frame.calls) {
                if (call.method.startsWith('finish')) continue;
                callCounts[call.method] = (callCounts[call.method] || 0) + 1;
            }
            const sorted = Object.keys(callCounts)
                .map(method => ({ method, count: callCounts[method] }))
                .sort((a, b) => b.count - a.count);

            for (const call of sorted) {
                const block = document.createElement('div');
                block.style.cssText = `padding:4px 8px;margin:2px 0;border-left:4px solid ${this._getColorForMethod(call.method)};background:rgba(255,255,255,0.03);font-family:monospace;font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
                block.textContent = call.method + (call.count > 1 ? ` ( ${call.count} )` : '');
                frag.appendChild(block);
            }
        }

        this.timelineTrack.appendChild(frag);
    }

    private _getColorForMethod(method: string): string {
        if (method.startsWith('begin'))   return 'var(--color-green)';
        if (method.startsWith('finish') || method.startsWith('destroy')) return 'var(--color-red)';
        if (method.startsWith('draw') || method.startsWith('compute') || method.startsWith('create') || method.startsWith('generate')) return 'var(--color-yellow)';
        return 'var(--text-secondary)';
    }
}
