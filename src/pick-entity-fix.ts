import { _Pick_PickableBase } from '@awayjs/view';

// A pickable abstraction cleared on its own (an asset disposed when the game
// swaps a weapon or armour piece) left its pick entity's active list intact.
// The next box-bounds query or hit test then read the cleared wrapper and
// threw "Cannot read properties of null (reading 'deref')", which stopped the
// frame. Invalidate the owning entity first, so it rebuilds the list from the
// live display tree on its next query.
const proto = <any> _Pick_PickableBase.prototype;
const onClear = proto.onClear;
proto.onClear = function (this: any): void {
	const entity = this._pool;
	onClear.call(this);
	entity?.onInvalidate?.();
};
