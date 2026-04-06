import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { Download, Upload, FileText, Loader2, CheckCircle2, X, Trash2, Scissors, ChevronRight, ChevronLeft, Save, Keyboard, Trash, Archive, Settings, Key, Check, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import { detectSignatures, checkApiKey as verifyApiKey } from './services/gemini';
import { generateUsername, cn } from './lib/utils';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface DetectedRow {
  id: string;
  originalName: string;
  username: string;
  rowImage: string; // Base64 of the entire row
  processed: boolean;
  finalDataUrl?: string;
  aiCrop?: { x: number, y: number, w: number, h: number };
  erasures?: { points: { x: number, y: number }[], size: number }[];
}

export default function App() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState('');
  const [rows, setRows] = useState<DetectedRow[]>([]);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // API Key state
  const [userApiKey, setUserApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [isCheckingApi, setIsCheckingApi] = useState(false);
  const [apiStatus, setApiStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [showApiConfig, setShowApiConfig] = useState(false);

  const handleCheckApi = async () => {
    if (!userApiKey) {
      setApiStatus('error');
      return;
    }
    setIsCheckingApi(true);
    setApiStatus('idle');
    const isValid = await verifyApiKey(userApiKey);
    setIsCheckingApi(false);
    if (isValid) {
      setApiStatus('success');
      localStorage.setItem('gemini_api_key', userApiKey);
    } else {
      setApiStatus('error');
    }
  };

  // Crop state
  const [cropRect, setCropRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number, y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Eraser & Mouse refs for performance
  const [mode, setMode] = useState<'crop' | 'eraser'>('crop');
  const [eraserSize, setEraserSize] = useState(15);
  const mousePosRef = useRef<{ x: number, y: number }>({ x: 0, y: 0 });
  const currentPathRef = useRef<{ x: number, y: number }[] | null>(null);
  const isDrawingRef = useRef(false);
  const [renderTrigger, setRenderTrigger] = useState(0); // Minimal trigger for state-based changes

  const processFile = async (file: File) => {
    setIsProcessing(true);
    setRows([]);
    setReviewIndex(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const numPages = pdf.numPages;

      const allRows: DetectedRow[] = [];

      for (let i = 1; i <= numPages; i++) {
        setProgress(`Đang quét trang ${i}/${numPages}...`);
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.5 }); 
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!;
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await (page.render({ canvasContext: context, viewport } as any)).promise;
        
        const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        const detections = await detectSignatures(base64Image, userApiKey);
        
        for (const detection of detections) {
          const [ymin, xmin, ymax, xmax] = detection.row_bbox;
          const [symin, sxmin, symax, sxmax] = detection.signature_bbox;
          
          // Add 10% vertical padding to the row to ensure no cutoff
          const rowPaddingY = (ymax - ymin) * 0.1;
          const paddedYmin = Math.max(0, ymin - rowPaddingY);
          const paddedYmax = Math.min(1000, ymax + rowPaddingY);

          const x = (xmin / 1000) * canvas.width;
          const y = (paddedYmin / 1000) * canvas.height;
          const width = ((xmax - xmin) / 1000) * canvas.width;
          const height = ((paddedYmax - paddedYmin) / 1000) * canvas.height;

          // Calculate AI suggested crop relative to the padded row
          const rawAiCropX = ((sxmin - xmin) / 1000) * canvas.width;
          const rawAiCropY = ((symin - paddedYmin) / 1000) * canvas.height;
          const rawAiCropW = ((sxmax - sxmin) / 1000) * canvas.width;
          const rawAiCropH = ((symax - symin) / 1000) * canvas.height;

          const paddingW = rawAiCropW * 0.05;
          const paddingH = rawAiCropH * 0.05;

          const aiCropX = Math.max(0, rawAiCropX - paddingW);
          const aiCropY = Math.max(0, rawAiCropY - paddingH);
          const aiCropW = Math.min(width - aiCropX, rawAiCropW + 2 * paddingW);
          const aiCropH = Math.min(height - aiCropY, rawAiCropH + 2 * paddingH);

          const rowCanvas = document.createElement('canvas');
          rowCanvas.width = width;
          rowCanvas.height = height;
          const rowCtx = rowCanvas.getContext('2d')!;
          rowCtx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
          
          // Advanced background and line removal
          const rowImageData = rowCtx.getImageData(0, 0, width, height);
          const rowData = rowImageData.data;
          
          // 1. Basic background removal (thresholding)
          for (let j = 0; j < rowData.length; j += 4) {
            const r = rowData[j];
            const g = rowData[j + 1];
            const b = rowData[j + 2];
            const brightness = (r + g + b) / 3;
            // If it's very bright, make it transparent
            if (brightness > 220) {
              rowData[j + 3] = 0;
            }
          }

          // 2. Simple Line Removal (Horizontal & Vertical)
          // This targets long straight lines which are likely table borders
          const threshold = 180; // Dark enough to be a line
          
          // Horizontal lines
          for (let rowY = 0; rowY < height; rowY++) {
            let darkCount = 0;
            for (let colX = 0; colX < width; colX++) {
              const idx = (rowY * width + colX) * 4;
              if (rowData[idx + 3] > 0 && (rowData[idx] + rowData[idx+1] + rowData[idx+2])/3 < threshold) {
                darkCount++;
              }
            }
            // If more than 70% of the row is dark, it's probably a table line
            if (darkCount > width * 0.7) {
              for (let colX = 0; colX < width; colX++) {
                const idx = (rowY * width + colX) * 4;
                rowData[idx + 3] = 0;
              }
            }
          }

          // Vertical lines
          for (let colX = 0; colX < width; colX++) {
            let darkCount = 0;
            for (let rowY = 0; rowY < height; rowY++) {
              const idx = (rowY * width + colX) * 4;
              if (rowData[idx + 3] > 0 && (rowData[idx] + rowData[idx+1] + rowData[idx+2])/3 < threshold) {
                darkCount++;
              }
            }
            // If more than 70% of the column is dark, it's probably a table line
            if (darkCount > height * 0.7) {
              for (let rowY = 0; rowY < height; rowY++) {
                const idx = (rowY * width + colX) * 4;
                rowData[idx + 3] = 0;
              }
            }
          }

          rowCtx.putImageData(rowImageData, 0, 0);

          allRows.push({
            id: Math.random().toString(36).substr(2, 9),
            originalName: detection.name,
            username: detection.username || generateUsername(detection.name),
            rowImage: rowCanvas.toDataURL('image/png'),
            processed: false,
            aiCrop: { x: aiCropX, y: aiCropY, w: aiCropW, h: aiCropH }
          });
        }
      }
      
      setRows(allRows);
      if (allRows.length > 0) setReviewIndex(0);
      setProgress('Hoàn tất quét!');
    } catch (error) {
      console.error('Error processing PDF:', error);
      setProgress('Đã xảy ra lỗi khi xử lý file.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSaveCurrent = useCallback(() => {
    if (reviewIndex === null || !cropRect) return;

    const row = rows[reviewIndex];
    
    // Create final cropped image
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = cropRect.w;
    finalCanvas.height = cropRect.h;
    const finalCtx = finalCanvas.getContext('2d')!;
    
    const img = new Image();
    img.onload = () => {
      // Draw image with erasures applied
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.width;
      tempCanvas.height = img.height;
      const tempCtx = tempCanvas.getContext('2d')!;
      tempCtx.drawImage(img, 0, 0);
      
      // Apply erasures
      if (row.erasures && row.erasures.length > 0) {
        tempCtx.globalCompositeOperation = 'destination-out';
        row.erasures.forEach(path => {
          if (path.points.length < 2) return;
          tempCtx.beginPath();
          tempCtx.lineWidth = path.size;
          tempCtx.lineCap = 'round';
          tempCtx.lineJoin = 'round';
          tempCtx.moveTo(path.points[0].x, path.points[0].y);
          for (let i = 1; i < path.points.length; i++) {
            tempCtx.lineTo(path.points[i].x, path.points[i].y);
          }
          tempCtx.stroke();
        });
        tempCtx.globalCompositeOperation = 'source-over';
      }

      finalCtx.drawImage(tempCanvas, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);
      
      const updatedRows = [...rows];
      updatedRows[reviewIndex] = {
        ...row,
        processed: true,
        finalDataUrl: finalCanvas.toDataURL('image/png')
      };
      setRows(updatedRows);

      // Move to next
      if (reviewIndex < rows.length - 1) {
        setReviewIndex(reviewIndex + 1);
        setCropRect(null); // Reset crop for next
      } else {
        setReviewIndex(null); // End of review
      }
    };
    img.src = row.rowImage;
  }, [reviewIndex, rows, cropRect]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (reviewIndex !== null) {
        if (e.code === 'Space') {
          e.preventDefault();
          handleSaveCurrent();
        } else if (e.code === 'ArrowRight') {
          setReviewIndex(prev => prev !== null && prev < rows.length - 1 ? prev + 1 : prev);
          setCropRect(null);
        } else if (e.code === 'ArrowLeft') {
          setReviewIndex(prev => prev !== null && prev > 0 ? prev - 1 : prev);
          setCropRect(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [reviewIndex, handleSaveCurrent, rows.length]);

  const [currentImage, setCurrentImage] = useState<HTMLImageElement | null>(null);

  // Unified Animation Loop for Canvas
  useEffect(() => {
    if (!currentImage || !canvasRef.current || reviewIndex === null) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    let animationFrameId: number;

    const render = () => {
      // Redraw everything
      if (canvas.width !== currentImage.width || canvas.height !== currentImage.height) {
        canvas.width = currentImage.width;
        canvas.height = currentImage.height;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Draw image
      ctx.drawImage(currentImage, 0, 0);

      // Draw erasures
      const row = rows[reviewIndex];
      if (!row) return;
      const erasures = row.erasures || [];
      
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      
      // Past erasures
      erasures.forEach(path => {
        if (path.points.length < 2) return;
        ctx.beginPath();
        ctx.lineWidth = path.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.moveTo(path.points[0].x, path.points[0].y);
        for (let i = 1; i < path.points.length; i++) {
          ctx.lineTo(path.points[i].x, path.points[i].y);
        }
        ctx.stroke();
      });

      // Current active erasure
      if (isDrawingRef.current && mode === 'eraser' && currentPathRef.current) {
        const path = currentPathRef.current;
        if (path.length >= 2) {
          ctx.beginPath();
          ctx.lineWidth = eraserSize;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.moveTo(path[0].x, path[0].y);
          for (let i = 1; i < path.length; i++) {
            ctx.lineTo(path[i].x, path[i].y);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
      
      // Draw Crop Rect
      if (cropRect) {
        ctx.strokeStyle = '#3B82F6';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
        ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
        ctx.fillRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      }

      // Draw Eraser Preview Circle (More distinct)
      if (mode === 'eraser') {
        const { x, y } = mousePosRef.current;
        
        // Outer glow
        ctx.beginPath();
        ctx.arc(x, y, eraserSize / 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.stroke();

        // Main circle
        ctx.beginPath();
        ctx.arc(x, y, eraserSize / 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(239, 68, 68, 1)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
        ctx.fill();

        // Center dot for precision
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.8)';
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [currentImage, cropRect, mode, eraserSize, reviewIndex, rows, renderTrigger]);

  // Load image and set initial crop when reviewIndex changes
  useEffect(() => {
    if (reviewIndex === null) {
      setCurrentImage(null);
      setCropRect(null);
      return;
    }
    
    setCurrentImage(null); // Reset to avoid stale rendering
    const row = rows[reviewIndex];
    if (!row) return;

    const img = new Image();
    img.onload = () => {
      setCurrentImage(img);
      // Set initial crop from AI if not already processed
      if (!row.processed && row.aiCrop) {
        setCropRect(row.aiCrop);
      }
    };
    img.src = row.rowImage;
  }, [reviewIndex, rows]);

  const handleMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    
    const x = e.nativeEvent.offsetX * scaleX;
    const y = e.nativeEvent.offsetY * scaleY;
    
    setIsDragging(true);
    isDrawingRef.current = true;

    if (mode === 'crop') {
      setDragStart({ x, y });
      setCropRect({ x, y, w: 0, h: 0 });
    } else {
      currentPathRef.current = [{ x, y }];
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    
    const mouseX = Math.max(0, Math.min(canvas.width, (e.clientX - (rect.left + canvas.clientLeft)) * scaleX));
    const mouseY = Math.max(0, Math.min(canvas.height, (e.clientY - (rect.top + canvas.clientTop)) * scaleY));
    
    mousePosRef.current = { x: mouseX, y: mouseY };

    if (!isDragging) return;
    
    if (mode === 'crop' && dragStart) {
      setCropRect({
        x: Math.min(mouseX, dragStart.x),
        y: Math.min(mouseY, dragStart.y),
        w: Math.abs(mouseX - dragStart.x),
        h: Math.abs(mouseY - dragStart.y)
      });
    } else if (mode === 'eraser' && currentPathRef.current) {
      currentPathRef.current.push({ x: mouseX, y: mouseY });
    }
  };

  const handleMouseUp = () => {
    if (mode === 'eraser' && currentPathRef.current && reviewIndex !== null) {
      const updatedRows = [...rows];
      const row = updatedRows[reviewIndex];
      updatedRows[reviewIndex] = {
        ...row,
        erasures: [...(row.erasures || []), { points: [...currentPathRef.current], size: eraserSize }]
      };
      setRows(updatedRows);
      currentPathRef.current = null;
    }
    setIsDragging(false);
    isDrawingRef.current = false;
  };

  const downloadAll = async () => {
    const processedRows = rows.filter(r => r.processed && r.finalDataUrl);
    if (processedRows.length === 0) return;

    setProgress('Đang nén file ZIP...');
    setIsProcessing(true);

    try {
      const zip = new JSZip();
      
      for (const row of processedRows) {
        const base64Data = row.finalDataUrl!.split(',')[1];
        zip.file(`${row.username}.png`, base64Data, { base64: true });
      }

      const content = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `signatures_${new Date().getTime()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Error creating ZIP:', error);
    } finally {
      setIsProcessing(false);
      setProgress('');
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8 text-center relative">
          <div className="absolute right-0 top-0">
            <button 
              onClick={() => setShowApiConfig(!showApiConfig)}
              className="p-2 rounded-full hover:bg-gray-100 transition-colors text-gray-500"
              title="Cấu hình API"
            >
              <Settings className="w-6 h-6" />
            </button>
          </div>

          <AnimatePresence>
            {showApiConfig && (
              <motion.div 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute right-0 top-12 z-50 bg-white p-6 rounded-3xl shadow-2xl border border-gray-100 w-80 text-left"
              >
                <div className="flex items-center gap-2 mb-4">
                  <Key className="w-5 h-5 text-blue-600" />
                  <h3 className="font-bold">Cấu hình Gemini API</h3>
                </div>
                <p className="text-xs text-gray-500 mb-4">
                  Nhập API Key của bạn để sử dụng quota riêng hoặc nếu Key mặc định bị lỗi.
                </p>
                <div className="space-y-4">
                  <div className="relative">
                    <input 
                      type="password" 
                      value={userApiKey}
                      onChange={(e) => {
                        setUserApiKey(e.target.value);
                        setApiStatus('idle');
                      }}
                      placeholder="Nhập API Key..."
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {apiStatus === 'success' && <Check className="absolute right-3 top-2.5 w-4 h-4 text-green-500" />}
                    {apiStatus === 'error' && <AlertCircle className="absolute right-3 top-2.5 w-4 h-4 text-red-500" />}
                  </div>
                  <button 
                    onClick={handleCheckApi}
                    disabled={isCheckingApi || !userApiKey}
                    className="w-full py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isCheckingApi ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Kiểm tra kết nối
                  </button>
                  {apiStatus === 'success' && <p className="text-[10px] text-green-600 text-center font-medium">Kết nối thành công! Đã lưu Key.</p>}
                  {apiStatus === 'error' && <p className="text-[10px] text-red-600 text-center font-medium">Lỗi: Key không hợp lệ hoặc hết hạn.</p>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-bold uppercase tracking-wider mb-4">
            <Scissors className="w-3 h-3" />
            Signature Extractor v2
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">
            Trích xuất chữ ký (Thủ công)
          </h1>
          <p className="text-gray-500">
            Quét PDF → Kéo thả để cắt → Space để lưu & tiếp theo
          </p>
        </header>

        {/* Upload Area */}
        {!isProcessing && rows.length === 0 && (
          <motion.div
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-gray-300 rounded-3xl p-16 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50/30 transition-all group"
          >
            <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:bg-blue-200 transition-colors">
              <Upload className="w-8 h-8 text-blue-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Tải lên file PDF</h3>
            <p className="text-gray-400">Hệ thống sẽ tự động tách các hàng cho bạn duyệt</p>
            <input type="file" ref={fileInputRef} onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])} accept="application/pdf" className="hidden" />
          </motion.div>
        )}

        {isProcessing && (
          <div className="bg-white rounded-3xl p-12 shadow-sm border border-gray-100 text-center">
            <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-6" />
            <h3 className="text-xl font-semibold mb-2">Đang quét tài liệu...</h3>
            <p className="text-blue-600 font-medium">{progress}</p>
          </div>
        )}

        {/* Review Mode */}
        {reviewIndex !== null && rows.length > 0 && (
          <div className="space-y-6">
            <div className="flex items-center justify-between bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
              <div className="flex items-center gap-4 flex-1">
                <div className="bg-blue-600 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold shrink-0">
                  {reviewIndex + 1}
                </div>
                <div className="flex-1 max-w-md">
                  <input 
                    type="text" 
                    value={rows[reviewIndex].originalName}
                    onChange={(e) => {
                      const updated = [...rows];
                      updated[reviewIndex].originalName = e.target.value;
                      setRows(updated);
                    }}
                    className="font-bold text-lg bg-transparent border-b border-transparent hover:border-gray-200 focus:border-blue-500 focus:outline-none w-full"
                    placeholder="Tên người ký"
                  />
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-gray-400 font-mono">Lưu thành:</span>
                    <input 
                      type="text" 
                      value={rows[reviewIndex].username}
                      onChange={(e) => {
                        const updated = [...rows];
                        updated[reviewIndex].username = e.target.value;
                        setRows(updated);
                      }}
                      className="text-xs text-blue-600 font-mono bg-transparent border-b border-transparent hover:border-gray-200 focus:border-blue-500 focus:outline-none w-32"
                      placeholder="filename"
                    />
                    <span className="text-xs text-gray-400 font-mono">.png</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="hidden md:flex items-center gap-2 text-xs text-gray-400 mr-4">
                  <Keyboard className="w-4 h-4" />
                  <span><b>Space</b>: Lưu | <b>← →</b>: Duyệt</span>
                </div>
                <button 
                  onClick={() => {
                    setReviewIndex(Math.max(0, reviewIndex - 1));
                    setCropRect(null);
                  }}
                  className="p-2 rounded-xl hover:bg-gray-100 disabled:opacity-30"
                  disabled={reviewIndex === 0}
                  title="Trước đó"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button 
                  onClick={() => {
                    setReviewIndex(Math.min(rows.length - 1, reviewIndex + 1));
                    setCropRect(null);
                  }}
                  className="p-2 rounded-xl hover:bg-gray-100 disabled:opacity-30 mr-2"
                  disabled={reviewIndex === rows.length - 1}
                  title="Tiếp theo (Bỏ qua)"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
                <button 
                  onClick={handleSaveCurrent}
                  className="px-6 py-2 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 flex items-center gap-2 shadow-lg shadow-blue-200"
                >
                  <Save className="w-4 h-4" />
                  Lưu & Tiếp theo
                </button>
              </div>
            </div>

            <div className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100 flex flex-col items-center">
              <div className="flex items-center justify-between w-full mb-4">
                <div className="flex items-center gap-4">
                  <div className="flex bg-gray-100 p-1 rounded-xl">
                    <button 
                      onClick={() => setMode('crop')}
                      className={cn(
                        "px-4 py-1.5 rounded-lg text-sm font-semibold transition-all flex items-center gap-2",
                        mode === 'crop' ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                      )}
                    >
                      <Scissors className="w-4 h-4" />
                      Cắt
                    </button>
                    <button 
                      onClick={() => setMode('eraser')}
                      className={cn(
                        "px-4 py-1.5 rounded-lg text-sm font-semibold transition-all flex items-center gap-2",
                        mode === 'eraser' ? "bg-white text-red-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                      )}
                    >
                      <Trash className="w-4 h-4" />
                      Bút xóa
                    </button>
                  </div>
                  {mode === 'eraser' && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">Cỡ:</span>
                      <input 
                        type="range" 
                        min="5" 
                        max="50" 
                        value={eraserSize} 
                        onChange={(e) => setEraserSize(parseInt(e.target.value))}
                        className="w-24 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-red-500"
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <button 
                    onClick={() => {
                      if (reviewIndex !== null) {
                        const updated = [...rows];
                        updated[reviewIndex].erasures = [];
                        setRows(updated);
                        setRenderTrigger(prev => prev + 1);
                      }
                    }}
                    className="text-xs text-gray-400 font-semibold hover:underline"
                  >
                    Xóa tất cả tẩy
                  </button>
                  <button 
                    onClick={() => setCropRect(null)}
                    className="text-xs text-red-500 font-semibold hover:underline"
                  >
                    Xoá vùng chọn
                  </button>
                </div>
              </div>
              <div className="relative border border-gray-200 rounded-xl overflow-hidden shadow-inner">
                <canvas 
                  ref={canvasRef}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  className={cn(
                    "max-w-full block checkerboard",
                    mode === 'crop' ? "cursor-crosshair" : "cursor-none"
                  )}
                />
              </div>
            </div>
          </div>
        )}

        {/* Final Results / Download */}
        {reviewIndex === null && rows.length > 0 && (
          <div className="space-y-6">
            <div className="flex items-center justify-between bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
              <div>
                <h2 className="text-2xl font-bold">Hoàn tất xử lý</h2>
                <p className="text-gray-500">Đã duyệt {rows.filter(r => r.processed).length}/{rows.length} chữ ký</p>
              </div>
              <div className="flex gap-3">
                <button 
                  onClick={() => { setRows([]); setReviewIndex(null); }}
                  className="px-6 py-3 rounded-2xl border border-gray-200 font-semibold hover:bg-gray-50 flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  Làm lại
                </button>
                <button 
                  onClick={downloadAll}
                  className="px-8 py-3 rounded-2xl bg-blue-600 text-white font-semibold hover:bg-blue-700 flex items-center gap-2 shadow-lg shadow-blue-200"
                >
                  <Download className="w-4 h-4" />
                  Tải về tất cả
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {rows.map((row, idx) => (
                <div 
                  key={row.id}
                  className={cn(
                    "bg-white p-3 rounded-2xl border cursor-pointer transition-all hover:scale-105 group relative",
                    row.processed ? "border-green-200 bg-green-50/20" : "border-gray-100"
                  )}
                  onClick={() => setReviewIndex(idx)}
                >
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      const updated = rows.filter((_, i) => i !== idx);
                      setRows(updated);
                      if (reviewIndex === idx) setReviewIndex(null);
                      else if (reviewIndex !== null && reviewIndex > idx) setReviewIndex(reviewIndex - 1);
                    }}
                    className="absolute -top-2 -right-2 p-1.5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-10"
                    title="Xoá hàng này"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  <div className="aspect-video bg-gray-100 rounded-xl mb-2 flex items-center justify-center overflow-hidden relative group/img">
                    {row.finalDataUrl ? (
                      <>
                        <img src={row.finalDataUrl} className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" />
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            const link = document.createElement('a');
                            link.href = row.finalDataUrl!;
                            link.download = `${row.username}.png`;
                            link.click();
                          }}
                          className="absolute top-1 right-1 p-1 bg-white/80 rounded-lg opacity-0 group-hover/img:opacity-100 transition-opacity shadow-sm"
                        >
                          <Download className="w-3 h-3 text-blue-600" />
                        </button>
                      </>
                    ) : (
                      <img src={row.rowImage} className="max-w-full max-h-full object-cover opacity-30" referrerPolicy="no-referrer" />
                    )}
                  </div>
                  <p className="text-xs font-bold truncate">{row.originalName}</p>
                  {row.processed && <CheckCircle2 className="w-4 h-4 text-green-500 mt-1" />}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
