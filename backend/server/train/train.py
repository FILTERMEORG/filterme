import pathlib, pickle
import numpy as np, pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import precision_score, recall_score

base = pathlib.Path(__file__).parent.parent
X = np.load(base / "data" / "embeddings.npy")
L = pd.read_parquet(base / "data" / "labels.parquet")
model_dir = base / "model"; model_dir.mkdir(exist_ok=True)

for col in ["profanity", "sexual", "political"]:
    y = (L[col].values >= 40).astype(int)            # 유해 여부 (0/1)
    Xtr, Xte, ytr, yte = train_test_split(
        X, y, test_size=0.1, random_state=42, stratify=y)

    m = LogisticRegression(max_iter=1000, class_weight="balanced")
    m.fit(Xtr, ytr)

    pred = (m.predict_proba(Xte)[:, 1] >= 0.5).astype(int)
    p = precision_score(yte, pred)
    r = recall_score(yte, pred)
    print(f"{col:10s} precision={p:.2f}  recall={r:.2f}  (양성 {y.mean()*100:.1f}%)")

    pickle.dump(m, open(model_dir / f"{col}.pkl", "wb"))

print("모델 저장:", model_dir)