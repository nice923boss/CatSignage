// 發送端主行程用隱藏視窗開這頁：影片跳到代表畫格、畫面更新兩次後，主行程再截圖存成縮圖
window.frameReady = new Promise((resolve) => {
  const video = document.getElementById('frame')
  const src = new URLSearchParams(location.search).get('src')
  if (!src) {
    resolve(false)
    return
  }
  video.addEventListener('error', () => resolve(false), { once: true })
  video.addEventListener('loadedmetadata', () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    video.currentTime = Math.min(duration * 0.1, 5) // 片頭常是黑畫面，取前 10%，最多第 5 秒
  }, { once: true })
  video.addEventListener('seeked', () => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
  }, { once: true })
  video.src = src
})
