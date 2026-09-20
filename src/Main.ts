import { AVMPlayer } from "../index"
import { Settings } from "@awayfl/avm2";

class Main extends AVMPlayer {
	constructor(gameConfig: any) {
		if (gameConfig.filename === "as3pb-bench") {
			// This optimized SWF reuses local register 0, so it cannot map to JS `this`.
			Settings.EMIT_REAL_THIS = false;
		}
		super(gameConfig);

        // LoaderInfo.DefaultLocation="/";
        // gameConfig.redirects = [{
        //     test: /img/,
        //     resolve: (url) => `./assets/${url.replace(/\/\//g,'')}`
		// },{
        //     test: /media/,
        //     resolve: (url) => `./assets/${url.replace(/\/\//g,'')}`
		// }];
    }
};

window["AVMPlayerClass"] = Main;
