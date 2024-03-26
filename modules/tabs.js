export function vis(c) {
    let self = this
    const browserProps = {
        hidden: "visibilitychange",
        msHidden: "msvisibilitychange",
        webkitHidden: "webkitvisibilitychange",
        mozHidden: "mozvisibilitychange",
    }
    for (item in browserProps) {
        if (item in document) {
            eventKey = browserProps[item]
            break
        }
    }	

    if (c) {
        if (!self._init && !(typeof document.addEventListener === "undefined")) {
            document.addEventListener(eventKey, c)
            self._init = true
            c()
        } 
    }
    return  !document[item] 
}
  