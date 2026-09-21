export async function loadBattleonFixture(p) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const game = p.root._children.find((n) => n.name === "scene")?.adapter;
  if (!game?.sec) throw Error("Wait for the game login screen.");
  const s = game.sec,
    loader = new s.flash.display.Loader();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Map load timed out")), 60000);
    loader.$BgcontentLoaderInfo.$BgaddEventListener("complete", () => {
      clearTimeout(timer);
      resolve();
    });
    loader.$BgcontentLoaderInfo.$BgaddEventListener("ioError", (e) => {
      clearTimeout(timer);
      reject(Error(e.$Bgtext));
    });
    loader.$Bgload(
      new s.flash.net.URLRequest(
        "/game/gamefiles/maps/battleon/town-battleon-18sep26.swf",
      ),
    );
  });
  const map = loader.$Bgcontent,
    host = s.flash.display.MovieClip.axClass.axConstruct([]);
  host.$BgmyAvatar = null;
  host.$BggetQuestValue = () => 0;
  host.$BginitMap = () => s.createObjectFromJS({});
  host.$BgobjSession = s.createObjectFromJS({ objFoundEggs: {} });
  host.$BgstrFrame = "Enter";
  host.$BgcellSetup = () => {
    host.$BgmyAvatar = s.createObjectFromJS({
      objData: { intAccessLevel: 0 },
      target: null,
    });
  };
  game.$Bgworld = host;
  game.$BgaddChild(host);
  host.$BgaddChild(map);
  map.$BggotoAndPlay("Blank");
  await delay(2500);
  const source = map.adaptee._children[0],
    a = source.adapter,
    b = new s.flash.display.BitmapData(960, 500, true, 0x00999999);
  const origin = a.$BgglobalToLocal(new s.flash.geom.Point(0, 0)),
    matrix = new s.flash.geom.Matrix(
      source.scaleX,
      0,
      0,
      source.scaleY,
      -origin.$Bgx * source.scaleX,
      -origin.$Bgy * source.scaleY,
    );
  b.$Bgdraw(
    a,
    matrix,
    null,
    null,
    new s.flash.geom.Rectangle(0, 0, 960, 500),
    false,
  );
  const bitmap = s.flash.display.Bitmap.axClass.axConstruct([b]);
  map.$BgaddChildAt(bitmap, map.$BggetChildIndex(a) + 1);
  a.$Bgvisible = false;
  return { map, host };
}
