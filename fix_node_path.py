import winreg

key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_READ | winreg.KEY_WRITE)
path, _ = winreg.QueryValueEx(key, 'PATH')

# Remove wrong F:\Node if present, add correct F:\Node\nodejs
parts = [p for p in path.split(';') if p.strip()]
# Remove old F:\Node (not F:\Node\nodejs)
parts = [p for p in parts if p.lower() != r'f:\node']
# Add correct path if missing
if r'F:\Node\nodejs' not in [p.lower() for p in parts]:
    parts.insert(0, r'F:\Node\nodejs')

new_path = ';'.join(parts)
winreg.SetValueEx(key, 'PATH', 0, winreg.REG_EXPAND_SZ, new_path)
winreg.CloseKey(key)

print('Fixed PATH. Added: F:\\Node\\nodejs')
print('Please log out and log back in for changes to take effect.')
