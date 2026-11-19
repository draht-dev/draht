const util = require("./util");
const { pick } = require("./util");
const make = require("./make")
  , build = require("./build");

function go() {
	util.pick(1);
	pick(2);
	build();
	return make();
}
module.exports = go;
