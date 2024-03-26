export function vis(c) {
    let item = '';
    let eventKey = '';

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
        if (!(typeof document.addEventListener === "undefined")) {
            document.addEventListener(eventKey, c)
            c()
        } 
    }
    return  !document[item] 
}
  