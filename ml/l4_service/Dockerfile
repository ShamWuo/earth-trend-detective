FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

WORKDIR /app

COPY ml /app/ml

RUN pip install --no-cache-dir -r /app/ml/l4_service/requirements.txt

ENV PYTHONPATH=/app/ml
ENV PORT=8080

EXPOSE 8080

CMD ["uvicorn", "l4_service.app:app", "--host", "0.0.0.0", "--port", "8080"]
