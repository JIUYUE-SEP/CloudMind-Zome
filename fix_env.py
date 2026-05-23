import winreg

key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_READ | winreg.KEY_WRITE)
path, _ = winreg.QueryValueEx(key, 'PATH')

paths_to_add = [r'F:\Node']
missing = [p for p in paths_to_add if p.lower() not in path.lower()]

if missing:
    new_path = ';'.join(missing) + ';' + path
    winreg.SetValueEx(key, 'PATH', 0, winreg.REG_EXPAND_SZ, new_path)
    print('Added:', missing)
else:
    print('All paths already exist')

winreg.CloseKey(key)
print('Current PATH starts with:', path[:100])
