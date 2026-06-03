import React, { useState, useRef } from 'react';

export default function ImageCropModal({ imageUrl, onCrop, onCancel }) {
  const containerRef = useRef(null);
  const imgRef = useRef(null);

  const [cropState, setCropState] = useState({
    isDragging: false,
    startX: 0,
    startY: 0,
    currX: 0,
    currY: 0,
  });

  const handleMouseDown = (e) => {
    e.preventDefault();
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCropState({ isDragging: true, startX: x, startY: y, currX: x, currY: y });
  };

  const handleMouseMove = (e) => {
    if (!cropState.isDragging || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;

    // Constrain to container
    x = Math.max(0, Math.min(x, rect.width));
    y = Math.max(0, Math.min(y, rect.height));

    setCropState(prev => ({ ...prev, currX: x, currY: y }));
  };

  const handleMouseUp = () => {
    if (cropState.isDragging) {
      setCropState(prev => ({ ...prev, isDragging: false }));
    }
  };

  const handleConfirm = () => {
    const img = imgRef.current;
    if (!img) return;

    const rect = img.getBoundingClientRect();

    // Scale factor between rendered size and actual natural size
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;

    const cropX = Math.min(cropState.startX, cropState.currX);
    const cropY = Math.min(cropState.startY, cropState.currY);
    const cropW = Math.abs(cropState.currX - cropState.startX);
    const cropH = Math.abs(cropState.currY - cropState.startY);

    if (cropW < 10 || cropH < 10) {
      alert('请框选至少 10x10 像素的区域');
      return;
    }

    const actualX = cropX * scaleX;
    const actualY = cropY * scaleY;
    const actualW = cropW * scaleX;
    const actualH = cropH * scaleY;

    const canvas = document.createElement('canvas');
    canvas.width = actualW;
    canvas.height = actualH;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(
      img,
      actualX, actualY, actualW, actualH,
      0, 0, actualW, actualH
    );

    const dataUrl = canvas.toDataURL('image/png', 1.0);
    onCrop(dataUrl, { width: Math.round(actualW), height: Math.round(actualH) });
  };

  // Full Image URL mapping (same as ImageAnnotationEditor)
  const fullImageUrl = imageUrl.startsWith('http') || imageUrl.startsWith('data:')
    ? imageUrl
    : `${window.location.origin}${imageUrl}`;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 10000,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        background: '#2a2a2a', padding: '20px', borderRadius: '12px',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        maxWidth: '95vw', maxHeight: '95vh', boxShadow: '0 20px 60px rgba(0,0,0,0.8)'
      }}>
        <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
          <h3 style={{ color: 'white', margin: 0 }}>✂️ 提取材质细节</h3>
          <button onClick={onCancel} style={{ background: 'transparent', border: 'none', color: '#ccc', cursor: 'pointer', fontSize: '18px' }}>✕</button>
        </div>
        <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 15px 0', alignSelf: 'flex-start' }}>
          在下方图片上拖拽鼠标，框选出你想提取的局部质感区域。框选的部分将无损提取，保留极高像素。
        </p>

        <div style={{ overflow: 'auto', maxWidth: '100%', maxHeight: '70vh', background: '#1a1a1a', borderRadius: '8px' }}>
          <div
            ref={containerRef}
            style={{ position: 'relative', display: 'inline-block', cursor: 'crosshair', margin: '10px' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <img
              ref={imgRef}
              src={fullImageUrl}
              alt="crop source"
              draggable={false}
              crossOrigin="anonymous"
              style={{ maxWidth: '85vw', maxHeight: 'none', display: 'block', userSelect: 'none' }}
            />

            {(cropState.isDragging || cropState.currX !== cropState.startX) && (
              <div style={{
                position: 'absolute',
                border: '2px dashed #4CAF50',
                backgroundColor: 'rgba(76, 175, 80, 0.2)',
                left: Math.min(cropState.startX, cropState.currX),
                top: Math.min(cropState.startY, cropState.currY),
                width: Math.abs(cropState.currX - cropState.startX),
                height: Math.abs(cropState.currY - cropState.startY),
                pointerEvents: 'none'
              }} />
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '15px', marginTop: '20px', width: '100%', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{ padding: '10px 20px', background: '#444', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            style={{ padding: '10px 20px', background: '#4CAF50', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            ✅ 提取细节为新节点
          </button>
        </div>
      </div>
    </div>
  );
}
