// Source: https://dev.to/kvntzn/using-face-api-in-nodejs-38aj

import path from "path";
import tf from "@tensorflow/tfjs";
import faceapi from "@vladmandic/face-api";

// Models
const modelPathRoot = "./models";

let optionsSSDMobileNet;

export async function mainMuka() {
    console.log("Face api single process test");

    await faceapi.tf.setBackend("tensofflow");
}