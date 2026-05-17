import sys
import json
import struct
import pyautogui
import time
import threading
import keyboard
import tkinter as tk

pyautogui.FAILSAFE = True
stop_macro = False

def send_message(message):
    try:
        msg_json = json.dumps(message).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('I', len(msg_json)))
        sys.stdout.buffer.write(msg_json)
        sys.stdout.flush()
    except:
        pass

def read_message():
    try:
        text_length_bytes = sys.stdin.buffer.read(4)
        if len(text_length_bytes) == 0: return None
        text_length = struct.unpack('i', text_length_bytes)[0]
        text = sys.stdin.buffer.read(text_length).decode('utf-8')
        return json.loads(text)
    except:
        return None

def show_failsafe_ui():
    global stop_macro
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-alpha", 0.75)
    root.attributes("-topmost", True)
    
    sw = root.winfo_screenwidth()
    root.geometry(f"130x130+{sw-130}+0")
    root.configure(bg='#990000')
    
    lbl = tk.Label(root, text="[ X ]\nACİL\nDURDURMA\n(Fareyi Getir)", bg='#990000', fg='white', font=("Segoe UI", 11, "bold"))
    lbl.pack(expand=True, fill='both')
    
    def monitor():
        global stop_macro
        if keyboard.is_pressed('ctrl+q'): stop_macro = True
            
        x, y = pyautogui.position()
        if x >= sw - 130 and y <= 130: stop_macro = True
            
        if stop_macro: root.destroy()
        else: root.after(100, monitor)
            
    root.after(100, monitor)
    root.mainloop()

def run_macro():
    global stop_macro
    threading.Thread(target=show_failsafe_ui, daemon=True).start()
    
    time.sleep(3)
    start_x, start_y = pyautogui.position()
    
    # 500 Limitli Sonsuz Döngü
    for i in range(500):
        if stop_macro: break
        
        pyautogui.click(start_x, start_y)
        time.sleep(0.85) 
        if stop_macro: break
        
        presses = i + 2
        for _ in range(presses):
            pyautogui.press('down')
            time.sleep(0.04) 
            if stop_macro: break
            
        if stop_macro: break
        
        pyautogui.press('enter')
        
        time.sleep(0.4) 
        pyautogui.press('esc') 
        time.sleep(0.1)
        pyautogui.press('esc') 
        
        time.sleep(0.8) 
        
    send_message({"status": "STOPPED", "message": "Tarama tamamlandı."})

while True:
    msg = read_message()
    if msg is None:
        stop_macro = True
        break
    
    cmd = msg.get("command")
    if cmd == "START_MACRO":
        stop_macro = False
        threading.Thread(target=run_macro).start()
    elif cmd == "STOP_MACRO":
        # Eklentiden DUR sinyali geldiği an freni çek!
        stop_macro = True