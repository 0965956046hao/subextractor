import ast
import os

for root, dirs, files in os.walk(r"D:\Git\subextractor\backend\app"):
    for f in files:
        if f.endswith('.py'):
            path = os.path.join(root, f)
            try:
                with open(path, 'r', encoding='utf-8') as fh:
                    ast.parse(fh.read())
                print(f'OK: {path}')
            except SyntaxError as e:
                print(f'SYNTAX ERROR: {path}: {e}')
            except Exception as e:
                print(f'ERROR: {path}: {e}')