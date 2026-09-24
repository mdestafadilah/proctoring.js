var videoElem = document.getElementById("video");
var btnElm = document.getElementById("btnKamera");
var isPlaying = !!videoElem.srcObject;

if (!isPlaying) {
    alert('Mohon Aktifkan Kamera!');
}

export function cameraonoff() {
    if (!isPlaying) {
        cameraon();

        const Kamera = [{
            isPlaying : isPlaying,
            status: "Kamera Sedang On!",
            waktuCatat: (new Date()).toLocaleString()
        }];
        localStorage.setItem('Kamera', JSON.stringify(Kamera))

    } else {
        cameraoff();

        const Kamera = [{
            isPlaying : isPlaying,
            status: "Kamera Sedang Off!",
            waktuCatat: (new Date()).toLocaleString()
        }];
        localStorage.setItem('Kamera', JSON.stringify(Kamera))

    }
}

export function cameraon() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices
            .getUserMedia({
                video: true
            })
            .then(function (stream) {
                videoElem.srcObject = stream;
                videoElem.play();
            })
            .then(() => {
                isPlaying = true;
                btnElm.innerHTML = 'Kamera Off!';
            });
    }
}

export function cameraoff() {
    const stream = videoElem.srcObject;
    if (stream) {
        const tracks = stream.getTracks();

        tracks.forEach(function (track) {
            track.stop();
        });

        videoElem.srcObject = null;
        isPlaying = false;
        btnElm.innerHTML = 'Kamera On!';
    }
}