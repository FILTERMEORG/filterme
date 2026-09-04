import re
import pathlib
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer

CSV = "/Users/minchichi/Downloads/stage2_data_livechat_relabeled.csv"
SYNTH = "/Users/minchichi/Downloads/youtube_live_chat_training_14000.csv"

df = pd.read_csv(CSV)
df_synth = pd.read_csv(SYNTH)
df = pd.concat([df, df_synth], ignore_index=True)

# 문장 노이즈 정리
def clean(t):
    t = str(t)
    t = re.sub(r"'{2,}\s*([^']+?)\s*'{2,}", r"\1", t)   # ''미친''' → 미친 (핵심!)
    t = re.sub(r'"{2,}\s*([^"]+?)\s*"{2,}', r"\1", t)
    t = re.sub(r"#@?\w*#", "", t)                        # #@이름# 제거
    t = re.sub(r"['\"]{2,}", "", t)                      # 남은 따옴표 덩어리
    t = re.sub(r"[-–—]{2,}", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t

df["문장"] = df["문장"].map(clean)
df = df[df["문장"].str.len() > 0].reset_index(drop=True)

# 임베딩
model = SentenceTransformer("jhgan/ko-sroberta-multitask")
emb = model.encode(df["문장"].tolist(), batch_size=64,
                   show_progress_bar=True, normalize_embeddings=True)

# 저장
out = pathlib.Path(__file__).parent.parent / "data"
out.mkdir(exist_ok=True)
np.save(out / "embeddings.npy", emb)
df[["문장", "profanity", "sexual", "political", "spam"]].to_parquet(out / "labels.parquet")
print("완료:", emb.shape)
