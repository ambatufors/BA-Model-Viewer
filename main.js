import { initScene, clearScene, setCurrentModel, getScene, getCamera, getControls } from "./src/scene.js";
import { initControls } from "./src/controls.js";

const { scene, camera, controls } = initScene();

initControls(scene, controls, camera, clearScene, setCurrentModel);
